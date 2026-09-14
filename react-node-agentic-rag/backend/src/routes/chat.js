import { randomUUID } from 'node:crypto'
import { runAgent } from '../agent/graph.js'
import { AGENT_SYSTEM } from '../agent/prompts.js'
import { startTrace, flushObs } from '../obs/langfuse.js'
import { insertSession, getSession, insertMsg, listMsgs } from '../store/sqlite.js'
import { countPoints } from '../rag/qdrant.js'
import { config } from '../config.js'

const sse = (reply) => {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
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

    // 会话：无 sessionId 则以首问建会话
    let session = sessionId ? getSession.get(sessionId) : undefined
    if (!session) {
      const id = randomUUID()
      insertSession.run(id, question.slice(0, 24))
      session = { id }
    }

    // 历史（只回放 user/assistant 文本）+ 当前问题
    const history = listMsgs
      .all(session.id)
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-HISTORY_KEEP)

    // 降级预判：知识库为空时注入直答提示，省掉无意义的检索轮
    let kbEmptyNote = null
    if (config.fallbackDirect) {
      try {
        kbEmptyNote = (await countPoints()) === 0
          ? '当前知识库为空：直接用你的通用知识回答用户问题，不要调用 search_knowledge，并在回答开头注明「（知识库暂无资料，以下为通用知识回答）」。'
          : null
      } catch {} // Qdrant 抖动时不阻塞对话
    }

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
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) {
        clientGone = true
        abort.abort()
      }
    })

    const trace = startTrace({
      name: 'Agentic RAG 问答',
      input: { question, sessionId: session.id, topK },
      metadata: { stage: 'M2' },
    })
    const steps = []
    let sources = []
    const emit = (event, data) => {
      if (event === 'step') steps.push(data)
      else if (event === 'sources') sources = data.sources
      send(event, data)
    }
    const usageAcc = []
    const startedAt = Date.now()

    try {
      const result = await runAgent({
        messages: input,
        topK,
        signal: abort.signal,
        emit,
        trace,
        usageAcc,
      })

      const answer =
        [...result.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? ''
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

      send('usage', { elapsedSec: elapsed, rounds: result.stepCount, ...usage })
      send('done', { stopReason: result.stopReason ?? 'normal', sessionId: session.id })
    } catch (e) {
      if (clientGone) {
        trace.update({ level: 'WARNING', statusMessage: '客户端中断' })
        send('done', { stopReason: 'abort', sessionId: session.id })
      } else {
        req.log.error(e)
        trace.update({ level: 'ERROR', statusMessage: e.message })
        send('error', { message: e.message })
        send('done', { stopReason: 'error', sessionId: session.id })
      }
    } finally {
      reply.raw.end()
      flushObs()
    }
  })
}
