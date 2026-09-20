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
import { buildAgentSystem } from '../agent/prompts.js'
import { scanInjection } from '../agent/injection.js'
import { compressMemory, memoryFallback } from '../agent/memory.js'
import { rootSpan, runInCtx, flushObs } from '../obs/otel.js'
import { insertSession, getSession, insertMsg, getMemory, listAfterSeq, getDoc } from '../store/pg.js'
import { countPoints } from '../rag/qdrant.js'
import { canReadDoc, aclFor } from '../acl.js'
import { answerCacheKey, getAnswer, setAnswer, kbEpoch } from '../rag/answer-cache.js'
import { activeCollection } from '../domain/registry.js'
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

export default async function (app) {
  // M2 Agentic RAG 流式问答
  // 事件协议：step* / sources / delta* / usage / done|error
  app.post(
    '/api/chat',
    { config: { rateLimit: { max: config.rate.chatMax, timeWindow: '1 minute' } } }, // chat 单独收紧限流
    async (req, reply) => {
      const { question, topK = 5, sessionId, docId } = req.body ?? {}
      if (!question?.trim()) return reply.code(400).send({ error: 'question 必填' })
      // 指定文档问答：docId 必须对当前用户可读（RBAC 单点判定），否则 404 不泄露存在性
      // M17 定向集合：文档级 QA 按文档所属集合检索（用户显式点名，定向无歧义），
      // 通用问答仍走 activeCollection()（单激活语义不变）
      let doc = null
      if (docId) {
        doc = await getDoc(docId)
        if (!doc || !(await canReadDoc(req.user, doc))) return reply.code(404).send({ error: '文档不存在' })
      }

      // 会话：无 sessionId（或 sessionId 不属于当前用户）则以首问建新会话
      // 归属校验：别人的 sessionId 对本用户等同「不存在」，静默新建而非 403，避免泄露会话存在性
      let session = sessionId ? await getSession(sessionId) : undefined
      if (session && session.user_id !== req.user.sub) session = undefined
      if (!session) {
        const id = randomUUID()
        await insertSession(id, question.slice(0, 24), req.user.sub)
        session = { id }
      }

      // 降级预判：知识库为空时注入直答提示，省掉无意义的检索轮
      // （countPoints 是一次 Qdrant 往返，Qdrant 抖动时不阻塞对话——失败按"非空"处理）
      let kbEmptyNote = null
      if (config.fallbackDirect) {
        try {
          kbEmptyNote = (await countPoints(activeCollection())) === 0
            ? '当前知识库为空：直接用你的通用知识回答用户问题，不要调用 search_knowledge，并在回答开头注明「（知识库暂无资料，以下为通用知识回答）」。'
            : null
        } catch { } // Qdrant 抖动时不阻塞对话
      }

      const send = sse(reply)
      const abort = new AbortController()
      let clientGone = false
      // 登记在途流：服务优雅退出时被统一 abort（server.js），走静默收尾不卡 app.close()
      app.sseStreams.add(abort)
      abort.signal.addEventListener('abort', () => { clientGone = true }, { once: true })
      // 请求体读完后 req.raw 也会 close；以「响应未写完就 close」判定真断开
      // 真断开 → abort 上游 LLM 请求，不再浪费 token
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          clientGone = true
          abort.abort()
        }
      })

      // 观测根 span：一条 trace = 一次问答（Langfuse 经 langfuse.* 属性命名/分组）
      const suspect = scanInjection(question) // L1 入口打标：命中注入句式只降级审计，不拒绝
      const root = rootSpan('Agentic RAG 问答', {
        'langfuse.session.id': session.id, // 会话分组：同一 session 的 trace 归在一起
        'langfuse.user.id': req.user.sub,  // 用户分组：Langfuse 按 user 维度聚合
        'input.value': JSON.stringify({ question, topK }).slice(0, 2000),
        'rag.injection_suspect': suspect, // 观测面：可疑注入打标，便于审计/调参
      })
      const steps = []      // 过程事件存档（落库回放用）
      let sources = []      // 最终引用来源

      // ---- 回答缓存探测（ID6）：失败静默降级为未命中；acl 算好后供 runAgent 复用 ----
      let acl = null
      let cacheKey = null
      let cached = null
      if (config.answerCache.ttlSec > 0) {
        try {
          // M17 定向集合：缓存键 epoch 取文档所属集合（定向检索的语料更新才失效这条缓存，防脏读）
          acl = await aclFor(req.user) // M10 RBAC：缓存键指纹 + 召回过滤共用
          cacheKey = answerCacheKey({ question, topK, docId, acl, epoch: await kbEpoch(doc?.collection ?? activeCollection()) })
          cached = await getAnswer(cacheKey)
        } catch { } // pg/Redis 抖动 → 按未命中走主链路
      }

      if (cached) {
        // 命中：先落库再回放（客户端断开也不丢会话记录），stopReason=cache 与实答区分
        root.setAttr('langfuse.trace.metadata', JSON.stringify({ cacheHit: true, injectionSuspect: suspect }))
        try {
          await insertMsg(session.id, 'user', question, null)
          await insertMsg(session.id, 'assistant', cached.answer,
            JSON.stringify({ sources: cached.sources, steps: [], usage: cached.usage, stopReason: 'cache' }))
          if (!reply.raw.writableEnded) {
            send('step', { phase: 'observation', label: '缓存', content: '命中同类问答缓存，直接回放' })
            send('sources', { sources: cached.sources })
            for (let i = 0; i < cached.answer.length; i += 24) send('delta', { text: cached.answer.slice(i, i + 24) })
            send('usage', { elapsedSec: 0, rounds: 0, ...cached.usage })
            send('done', { stopReason: 'cache', sessionId: session.id, traceId: root.traceId })
          }
        } finally {
          root.end()
          reply.raw.end()
          await flushObs()
        }
        return
      }

      // emit 双通道：一边实时 SSE 推给前端，一边收集起来随消息落库
      const emit = (event, data) => {
        if (event === 'step') steps.push(data)
        else if (event === 'sources') {
          // 多轮检索跨轮合并：模型可能多轮 search_knowledge，只取最后一轮会丢掉
          // 前几轮已评估通过的相关资料（同块保留最高分）。
          // 保持首次出现顺序（Map 插入序）不重排：tools.js 的全局引用编号 [n]
          // 依赖「第 n 次新出现的块 = 列表第 n 项」，行内引用锚点靠它对位
          const byKey = new Map(sources.map((s) => [`${s.docId}:${s.chunkIndex}`, s]))
          for (const s of data.sources) {
            const k = `${s.docId}:${s.chunkIndex}`
            const prev = byKey.get(k)
            if (!prev) byKey.set(k, s)
            else if (prev.score < s.score) prev.score = s.score // 原位更新分数，不动顺序
          }
          sources = [...byKey.values()]
          send(event, { sources })
          return
        }
        send(event, data)
      }
      const usageAcc = [] // 各轮 usage 的累积器（graph.js 内 push）
      const startedAt = Date.now()

      // 长会话记忆压缩：窗口外历史滚动为摘要（挂根 span；失败退化为仅回放窗口，不阻断对话）
      let memoryNote = null
      try {
        memoryNote = await runInCtx(root, () =>
          compressMemory({ sessionId: session.id, emit, usageAcc, signal: abort.signal })
        )
      } catch (e) {
        req.log.warn(`[memory] 压缩失败，退化为窗口回放: ${e.message}`)
        memoryNote = await memoryFallback(session.id)
      }

      // 历史回放：压缩断点之后的所有消息（= 窗口 + 未压缩真空区，零丢失；
      // meta 里的 sources/steps 不回放：一次性过程数据，混进上下文反而干扰模型）
      const boundary = (await getMemory(session.id))?.summarized_seq ?? 0
      const history = (await listAfterSeq(session.id, boundary))
        .map((m) => ({ role: m.role, content: m.content }))

      // 组装最终输入：系统提示 → （可选）空库提示 → （可选）会话记忆摘要 → 断点后历史 → 当前问题
      const input = [
        { role: 'system', content: buildAgentSystem() },
        ...(kbEmptyNote ? [{ role: 'system', content: kbEmptyNote }] : []),
        ...(memoryNote
          ? [{ role: 'system', content: `（早期对话记忆摘要，供参考）\n${memoryNote}` }]
          : []),
        ...history,
        { role: 'user', content: question },
      ]

      try {
        // 运行 Agent 主图（ReAct 循环）—— 在根 span 上下文内执行，子 span 自动挂树
        acl ??= await aclFor(req.user) // M10 RBAC：缓存探测未算过时这里补算（密级/归属/授权召回前过滤）
        const result = await runInCtx(root, () =>
          runAgent({
            messages: input,
            topK,
            signal: abort.signal,
            emit,
            usageAcc,
            docId, // 指定文档问答范围（可选），贯穿到 search_kb 子图
            collection: doc?.collection, // M17 定向集合：文档级 QA 检索文档所属集合
            acl,
          })
        )

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

        root.setAttr('langfuse.trace.metadata', JSON.stringify({
          elapsedSec: elapsed, rounds: result.stepCount, steps: steps.length, sources: sources.length,
          injectionSuspect: suspect,
        }))
        root.setAttr('output.value', answer)

        // 持久化：步骤/来源/用量随 meta 存档，刷新页面可回放
        await insertMsg(session.id, 'user', question, null)
        await insertMsg(
          session.id,
          'assistant',
          answer,
          JSON.stringify({ sources, steps, usage, stopReason: result.stopReason ?? 'normal' })
        )
        // 回填回答缓存（ID6）：成功实答才入缓存；abort/error 走 catch 不污染
        if (cacheKey) await setAnswer(cacheKey, { answer, sources, usage, rounds: result.stepCount })

        // 收尾事件：先 usage 后 done，前端按 done 收尾 UI；traceId 供评估脚本 score 回填关联
        send('usage', { elapsedSec: elapsed, rounds: result.stepCount, ...usage })
        send('done', { stopReason: result.stopReason ?? 'normal', sessionId: session.id, traceId: root.traceId })
      } catch (e) {
        if (clientGone) {
          // 用户主动关闭页面 → 静默收尾，不算服务端错误
          root.setAttr('langfuse.observation.level', 'WARNING')
          root.setAttr('langfuse.status_message', '客户端中断')
          send('done', { stopReason: 'abort', sessionId: session.id, traceId: root.traceId })
        } else {
          // 服务端错误 → 记日志 + error/done 事件通知前端
          req.log.error(e)
          root.setAttr('langfuse.observation.level', 'ERROR')
          root.setAttr('langfuse.status_message', e.message)
          send('error', { message: e.message })
          send('done', { stopReason: 'error', sessionId: session.id, traceId: root.traceId })
        }
      } finally {
        // 无论成败：结束根 span → 注销在途流 → 关闭 SSE 流 → 冲刷观测数据
        app.sseStreams.delete(abort)
        root.end()
        reply.raw.end()
        await flushObs()
      }
    })
}
