// ============================================================================
// SSE 流式问答路由：POST /api/chat（Agentic RAG 核心入口）
// ----------------------------------------------------------------------------
// 事件协议（event: data:）：
//   step*      : Thought/Action/Observation 过程事件（前端展示推理过程）
//   sources    : 最终命中的知识库资料（引用展示）
//   delta*     : 正文 token 流（打字机效果）
//   usage      : token 用量 + 耗时 + 轮数
//   done/error : 结束标记（stopReason: normal | max_iter | abort | error）
// 主流程：参数校验 → 会话管理 → 组装上下文 → 降级预判 → runAgent → 汇总落库。
// ============================================================================

import { randomUUID } from 'node:crypto'
import { runAgent } from '../agent/graph.js'
import { AGENT_SYSTEM } from '../agent/prompts.js'
import { startTrace, flushObs } from '../obs/langfuse.js'
import { insertSession, getSession, insertMsg, listMsgs } from '../store/sqlite.js'
import { countPoints } from '../rag/qdrant.js'
import { config } from '../config.js'

/**
 * 把 Fastify reply 接管为 SSE 流，并返回事件发送函数。
 * 关键响应头：
 *   - text/event-stream : SSE 协议
 *   - no-cache + keep-alive : 禁缓存、保持长连接
 *   - x-accel-buffering: no : 告诉 Nginx 等反代关闭缓冲（否则流式失效）
 */
const sse = (reply) => {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // 发送函数：序列化 data 为 JSON，按 SSE 规范以两个换行结束一帧
  return (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const HISTORY_KEEP = 20 // 多轮上下文窗口：最近 N 条

export default async function (app) {
  // M2 Agentic RAG 流式问答
  // 事件协议：step* / sources / delta* / usage / done|error
  app.post(
    '/api/chat',
    { config: { rateLimit: { max: config.rate.chatMax, timeWindow: '1 minute' } } }, // chat 单独收紧限流
    async (req, reply) => {
      const { question, topK = 5, sessionId } = req.body ?? {}
      if (!question?.trim()) return reply.code(400).send({ error: 'question 必填' })

      // 会话：无 sessionId 则以首问建会话（标题取问题前 24 字）
      let session = sessionId ? getSession.get(sessionId) : undefined
      if (!session) {
        const id = randomUUID()
        insertSession.run(id, question.slice(0, 24))
        session = { id }
      }

      // 历史（只回放 user/assistant 文本）+ 当前问题
      // meta 里的 sources/steps 不回放：那是一次性过程数据，混进上下文反而干扰模型
      const history = listMsgs
        .all(session.id)
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-HISTORY_KEEP)

      // 降级预判：知识库为空时注入直答提示，省掉无意义的检索轮
      // （countPoints 是一次 Qdrant 往返，Qdrant 抖动时不阻塞对话——失败按"非空"处理）
      let kbEmptyNote = null
      if (config.fallbackDirect) {
        try {
          kbEmptyNote = (await countPoints()) === 0
            ? '当前知识库为空：直接用你的通用知识回答用户问题，不要调用 search_knowledge，并在回答开头注明「（知识库暂无资料，以下为通用知识回答）」。'
            : null
        } catch { } // Qdrant 抖动时不阻塞对话
      }

      // 组装最终输入：系统提示 → （可选）空库提示 → 多轮历史 → 当前问题
      const input = [
        { role: 'system', content: AGENT_SYSTEM },
        ...(kbEmptyNote ? [{ role: 'system', content: kbEmptyNote }] : []),
        ...history,
        { role: 'user', content: question },
      ]

      const send = sse(reply)
      const abort = new AbortController()
      let clientGone = false
      // 请求体读完后 req.raw 也会 close；以「响应未写完就 close」判定真断开
      // 真断开 → abort 上游 LLM 请求，不再浪费 token
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          clientGone = true
          abort.abort()
        }
      })

      // Langfuse 链路追踪入口
      const trace = startTrace({
        name: 'Agentic RAG 问答',
        input: { question, sessionId: session.id, topK },
        metadata: { stage: 'M2' },
      })
      const steps = []      // 过程事件存档（落库回放用）
      let sources = []      // 最终引用来源
      // emit 双通道：一边实时 SSE 推给前端，一边收集起来随消息落库
      const emit = (event, data) => {
        if (event === 'step') steps.push(data)
        else if (event === 'sources') sources = data.sources
        send(event, data)
      }
      const usageAcc = [] // 各轮 usage 的累积器（graph.js 内 push）
      const startedAt = Date.now()

      try {
        // 运行 Agent 主图（ReAct 循环），SSE 事件经 emit 实时外发
        const result = await runAgent({
          messages: input,
          topK,
          signal: abort.signal,
          emit,
          trace,
          usageAcc,
        })

        // 最终答案 = 倒序找最后一条有正文的 assistant 消息
        const answer =
          [...result.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? ''
        // 汇总各轮 usage：sum(prompt_tokens / completion_tokens / total_tokens)
        const usage = usageAcc.reduce(
          (a, u) =>
            u
              ? {
                promptTokens: a.promptTokens + (u.prompt_tokens || 0),
                completionTokens: a.completionTokens + (u.completion_tokens || 0),
                totalTokens: a.totalTokens + (u.total_tokens || 0),
              }
              : a,
          { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        )
        const elapsed = +((Date.now() - startedAt) / 1000).toFixed(2)

        trace.update({
          output: answer,
          metadata: { elapsedSec: elapsed, rounds: result.stepCount, steps: steps.length, sources: sources.length },
        })

        // 持久化：步骤/来源/用量随 meta 存档，刷新页面可回放
        insertMsg.run(session.id, 'user', question, null)
        insertMsg.run(
          session.id,
          'assistant',
          answer,
          JSON.stringify({ sources, steps, usage, stopReason: result.stopReason ?? 'normal' })
        )

        // 收尾事件：先 usage 后 done，前端按 done 收尾 UI
        send('usage', { elapsedSec: elapsed, rounds: result.stepCount, ...usage })
        send('done', { stopReason: result.stopReason ?? 'normal', sessionId: session.id })
      } catch (e) {
        if (clientGone) {
          // 用户主动关闭页面 → 静默收尾，不算服务端错误
          trace.update({ level: 'WARNING', statusMessage: '客户端中断' })
          send('done', { stopReason: 'abort', sessionId: session.id })
        } else {
          // 服务端错误 → 记日志 + error/done 事件通知前端
          req.log.error(e)
          trace.update({ level: 'ERROR', statusMessage: e.message })
          send('error', { message: e.message })
          send('done', { stopReason: 'error', sessionId: session.id })
        }
      } finally {
        // 无论成败都要关闭 SSE 流并冲刷观测数据
        reply.raw.end()
        flushObs()
      }
    })
}
