// ============================================================================
// search_kb 子图（CRAG 模式 = Corrective RAG）
// ----------------------------------------------------------------------------
// 流程：retrieve（向量检索）→ grade（LLM 相关性评估）
//         → 足够 → END（hits 已过滤为相关子集）
//         → 不足且未超 attempts → rewrite（LLM 改写查询）→ retrieve（重检）
//         → 不足且超 attempts   → END（带现有结果返回，宁滥勿缺）
// 设计目标：通过"评估-改写-重试"的有界循环提升召回质量，同时防止无限重试。
// ============================================================================

import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { embedOne } from '../rag/embedder.js'
import { search } from '../rag/qdrant.js'
import { chatStructured } from '../llm.js'
import { config } from '../config.js'
import { gradeMessages, rewriteMessages, GRADE_SCHEMA, REWRITE_SCHEMA } from './prompts.js'
import { otelSpan } from '../obs/phoenix.js'

// 子图状态：attempt 记录已尝试次数，queries 是当前生效的查询词列表
const SearchState = Annotation.Root({
  question: Annotation({ reducer: (_, y) => y, default: () => '' }),  // 原始问题（改写基准）
  attempts: Annotation({ reducer: (_, y) => y, default: () => 0 }),   // 已重检次数
  queries: Annotation({ reducer: (_, y) => y, default: () => [] }),   // 本轮使用的查询词（1-2 个）
  hits: Annotation({ reducer: (_, y) => y, default: () => [] }),      // 检索+过滤后的资料块
  enough: Annotation({ reducer: (_, y) => y, default: () => false }), // 评估结论：材料是否足够
  feedback: Annotation({ reducer: (_, y) => y, default: () => '' }),  // 评估反馈（缺什么），喂给改写节点
})

// 检索：多查询并发 → 合并去重（同块保留最高分）→ 截断 topK
async function retrieveNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const topK = c.topK ?? 5 // 从主图 configurable 透传下来的检索条数
  const span = otelSpan('search_kb.retriever', 'RETRIEVER', {
    'input.value': JSON.stringify(state.queries),
  })

  // 每个查询词独立向量化 + 检索，Promise.all 并发执行
  const results = await Promise.all(
    state.queries.map(async (q) => search(await embedOne(q), { limit: topK }))
  )
  // 合并去重：key = docId:chunkIndex 定位同一内容块；重复命中保留分数最高的一次
  const byChunk = new Map()
  for (const hits of results) {
    for (const h of hits) {
      const key = `${h.docId}:${h.chunkIndex}`
      if (!byChunk.has(key) || byChunk.get(key).score < h.score) byChunk.set(key, h)
    }
  }
  // 按分数降序取 topK
  const merged = [...byChunk.values()].sort((a, b) => b.score - a.score).slice(0, topK)

  span.end(merged.map((h) => h.title))
  // Observation 事件：向前端汇报检索合并结果
  c.emit?.('step', {
    phase: 'observation',
    label: '检索',
    content: `查询 [${state.queries.join(' | ')}] → 合并去重后 ${merged.length} 块`,
  })
  return { hits: merged }
}

// 评估：LLM 逐条判相关 + 判断材料是否足够（返回形状由 GRADE_SCHEMA 经 tool-call 强制）
async function gradeNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const lfGen = c.trace?.generation?.({ name: `相关性评估(第${state.attempts}次)`, input: state.queries })
  const span = otelSpan('search_kb.grade', 'LLM', { 'input.value': state.question })

  let grade = null
  try {
    const { args, usage } = await chatStructured(
      gradeMessages(state.question, state.hits),
      GRADE_SCHEMA,
      { name: 'submit_grade', description: '提交相关性评估结果', signal: c.signal }
    )
    grade = args
    lfGen?.end?.({ output: args, usage: usage && { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } })
    span.end(args)
  } catch (e) {
    // 两轮自纠仍失败：评估器不可用，不阻断主链路 —— 全部保留，宁滥勿缺
    lfGen?.end?.({ output: e.message, level: 'ERROR', statusMessage: e.message })
    span.end(`评估失败: ${e.message}`)
  }

  let hits = state.hits
  let enough = false
  let feedback = ''
  if (grade && Array.isArray(grade.relevant)) {
    // 正常路径：仅保留 LLM 判定为相关的编号（编号从 1 开始，对应展示序号）
    const keep = new Set(grade.relevant.map(String))
    hits = state.hits.filter((_, i) => keep.has(String(i + 1)))
    enough = grade.enough === true
    feedback = grade.reason || ''
  } else {
    hits = state.hits // 评估失败兜底：全部保留
    enough = hits.length > 0 // 有结果就视为够用，避免误触发改写循环
  }

  c.emit?.('step', {
    phase: 'observation',
    label: '评估',
    content: `${enough ? '✅ 材料充足' : '⚠️ 材料不足'}：保留 ${hits.length}/${state.hits.length}${feedback ? `（${feedback}）` : ''}`,
  })
  return { hits, enough, feedback }
}

// 改写：材料不足时换 2 个问法重检（返回形状由 REWRITE_SCHEMA 经 tool-call 强制）
async function rewriteNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const lfGen = c.trace?.generation?.({ name: `查询改写(第${state.attempts}次)`, input: state.question })
  const span = otelSpan('search_kb.rewrite', 'LLM', { 'input.value': state.question })

  // 改写提示词包含：原问题 + 已尝试的查询（避免重复）+ 上一轮不足原因（对症改写）
  let queries = []
  try {
    const { args, usage } = await chatStructured(
      rewriteMessages(state.question, state.queries, state.feedback),
      REWRITE_SCHEMA,
      { name: 'submit_rewrite', description: '提交改写后的检索查询', signal: c.signal }
    )
    queries = args.queries
    lfGen?.end?.({ output: args, usage: usage && { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } })
    span.end(args)
  } catch (e) {
    lfGen?.end?.({ output: e.message, level: 'ERROR', statusMessage: e.message })
    span.end(`改写失败: ${e.message}`)
  }

  // 清洗改写结果：字符串化 → 滤空 → 最多取 2 个；失败兜底用原问题
  const next = (queries ?? []).map(String).filter(Boolean).slice(0, 2)
  const finalQueries = next.length ? next : [state.question]
  c.emit?.('step', { phase: 'thought', label: '改写重检', content: finalQueries.join(' | ') })
  // 返回新查询词并累加尝试次数；下一轮 retrieve 将使用新 queries
  return { queries: finalQueries, attempts: state.attempts + 1 }
}

// 条件路由：材料不足且还有重试额度 → rewrite；否则结束
// searchMaxAttempts 默认 2，即最多"改写→重检"2 次，防止无限循环烧 token
const shouldRetry = (state) =>
  !state.enough && state.attempts < config.agent.searchMaxAttempts ? 'rewrite' : END

// ---- 编译子图：retrieve → grade →（条件）rewrite → retrieve ----
export const searchGraph = new StateGraph(SearchState)
  .addNode('retrieve', retrieveNode)
  .addNode('grade', gradeNode)
  .addNode('rewrite', rewriteNode)
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', 'grade')
  .addConditionalEdges('grade', shouldRetry)
  .addEdge('rewrite', 'retrieve')
  .compile()
