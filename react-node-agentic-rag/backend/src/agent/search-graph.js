// search_kb 子图（CRAG 模式）：检索 → LLM 相关性评估 → 不足则改写重检（有界）
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { embedOne } from '../rag/embedder.js'
import { search } from '../rag/qdrant.js'
import { chatJSON, parseJSON } from '../llm.js'
import { config } from '../config.js'
import { gradeMessages, rewriteMessages } from './prompts.js'
import { otelSpan } from '../obs/phoenix.js'

const SearchState = Annotation.Root({
  question: Annotation({ reducer: (_, y) => y, default: () => '' }),
  attempts: Annotation({ reducer: (_, y) => y, default: () => 0 }),
  queries: Annotation({ reducer: (_, y) => y, default: () => [] }),
  hits: Annotation({ reducer: (_, y) => y, default: () => [] }),
  enough: Annotation({ reducer: (_, y) => y, default: () => false }),
  feedback: Annotation({ reducer: (_, y) => y, default: () => '' }),
})

// 检索：多查询并发 → 合并去重（同块保留最高分）→ 截断 topK
async function retrieveNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const topK = c.topK ?? 5
  const span = otelSpan('search_kb.retriever', 'RETRIEVER', {
    'input.value': JSON.stringify(state.queries),
  })

  const results = await Promise.all(
    state.queries.map(async (q) => search(await embedOne(q), { limit: topK }))
  )
  const byChunk = new Map()
  for (const hits of results) {
    for (const h of hits) {
      const key = `${h.docId}:${h.chunkIndex}`
      if (!byChunk.has(key) || byChunk.get(key).score < h.score) byChunk.set(key, h)
    }
  }
  const merged = [...byChunk.values()].sort((a, b) => b.score - a.score).slice(0, topK)

  span.end(merged.map((h) => h.title))
  c.emit?.('step', {
    phase: 'observation',
    label: '检索',
    content: `查询 [${state.queries.join(' | ')}] → 合并去重后 ${merged.length} 块`,
  })
  return { hits: merged }
}

// 评估：LLM 逐条判相关 + 判断材料是否足够
async function gradeNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const lfGen = c.trace?.generation?.({ name: `相关性评估(第${state.attempts}次)`, input: state.queries })
  const span = otelSpan('search_kb.grade', 'LLM', { 'input.value': state.question })

  const { content, usage } = await chatJSON(gradeMessages(state.question, state.hits), { signal: c.signal })
  const parsed = parseJSON(content)
  lfGen?.end?.({ output: content, usage: usage && { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } })
  span.end(content)

  let hits = state.hits
  let enough = false
  let feedback = ''
  if (parsed && Array.isArray(parsed.relevant)) {
    const keep = new Set(parsed.relevant.map(String))
    hits = state.hits.filter((_, i) => keep.has(String(i + 1)))
    enough = parsed.enough === true
    feedback = parsed.reason || ''
  } else {
    hits = state.hits // JSON 解析失败兜底：全部保留
    enough = hits.length > 0
  }

  c.emit?.('step', {
    phase: 'observation',
    label: '评估',
    content: `${enough ? '✅ 材料充足' : '⚠️ 材料不足'}：保留 ${hits.length}/${state.hits.length}${feedback ? `（${feedback}）` : ''}`,
  })
  return { hits, enough, feedback }
}

// 改写：材料不足时换 2 个问法重检
async function rewriteNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const lfGen = c.trace?.generation?.({ name: `查询改写(第${state.attempts}次)`, input: state.question })
  const span = otelSpan('search_kb.rewrite', 'LLM', { 'input.value': state.question })

  const { content, usage } = await chatJSON(rewriteMessages(state.question, state.queries, state.feedback), { signal: c.signal })
  const parsed = parseJSON(content)
  lfGen?.end?.({ output: content, usage: usage && { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } })
  span.end(content)

  const queries = (parsed?.queries ?? []).map(String).filter(Boolean).slice(0, 2)
  const next = queries.length ? queries : [state.question] // 兜底：改写失败用原问题
  c.emit?.('step', { phase: 'thought', label: '改写重检', content: next.join(' | ') })
  return { queries: next, attempts: state.attempts + 1 }
}

const shouldRetry = (state) =>
  !state.enough && state.attempts < config.agent.searchMaxAttempts ? 'rewrite' : END

export const searchGraph = new StateGraph(SearchState)
  .addNode('retrieve', retrieveNode)
  .addNode('grade', gradeNode)
  .addNode('rewrite', rewriteNode)
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', 'grade')
  .addConditionalEdges('grade', shouldRetry)
  .addEdge('rewrite', 'retrieve')
  .compile()
