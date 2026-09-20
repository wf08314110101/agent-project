// ============================================================================
// search_kb 子图（CRAG 模式 = Corrective RAG）
// ----------------------------------------------------------------------------
// 流程：retrieve（向量检索）→ grade（LLM 相关性评估）
//         → 足够 → END（hits 已过滤为相关子集）
//         → 不足且未超 attempts → rewrite（LLM 改写查询）→ retrieve（重检）
//         → 不足且超 attempts、未联网兜底过 → web_search（网络搜索）→ grade（复用评估过滤）
//         → 不足且超 attempts、已兜底 / 兜底关闭 → END（带现有结果返回，宁滥勿缺）
// 设计目标：通过"评估-改写-重试-联网"的有界漏斗提升召回质量，同时防止无限重试。
// ============================================================================

import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { createHash } from 'node:crypto'
import { embedOne } from '../rag/embedder.js'
import { hybridSearch } from '../rag/qdrant.js'
import { webSearch, webSearchAvailable } from '../rag/websearch.js'
import { chatStructured } from '../llm.js'
import { config } from '../config.js'
import { gradeMessages, rewriteMessages, GRADE_SCHEMA, REWRITE_SCHEMA } from './prompts.js'
import { otelSpan } from '../obs/otel.js'
import { activeCollection } from '../domain/registry.js'

// 子图状态：attempt 记录已尝试次数，queries 是当前生效的查询词列表
const SearchState = Annotation.Root({
  question: Annotation({ reducer: (_, y) => y, default: () => '' }),  // 原始问题（改写基准）
  attempts: Annotation({ reducer: (_, y) => y, default: () => 0 }),   // 已重检次数
  queries: Annotation({ reducer: (_, y) => y, default: () => [] }),   // 本轮使用的查询词（1-2 个）
  hits: Annotation({ reducer: (_, y) => y, default: () => [] }),      // 检索+过滤后的资料块
  enough: Annotation({ reducer: (_, y) => y, default: () => false }), // 评估结论：材料是否足够
  feedback: Annotation({ reducer: (_, y) => y, default: () => '' }),  // 评估反馈（缺什么），喂给改写节点
  webEligible: Annotation({ reducer: (_, y) => y, default: () => false }), // 允许联网兜底（gradeNode 写入，供路由判读）
  webTried: Annotation({ reducer: (_, y) => y, default: () => false }),    // 已联网兜底过（每轮最多一次）
  conflict: Annotation({ reducer: (_, y) => y, default: () => false }),    // M18b：资料间事实冲突标记（gradeNode 写入）
})

// 检索：多查询并发 → 混合检索（稠密+稀疏 RRF）→ 合并去重（同块保留最高分）→ 截断 topK
async function retrieveNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const topK = c.topK ?? 5 // 从主图 configurable 透传下来的检索条数
  const span = otelSpan('search_kb.retriever', 'RETRIEVER', {
    'input.value': JSON.stringify(state.queries),
  })

  // 每个查询词独立向量化 + 混合检索，Promise.all 并发执行
  // docId 存在时限定单文档范围（「对此文档提问」）；acl 为 M10 RBAC 密级过滤（贯穿自主图）
  let mode = 'hybrid-rrf'
  const results = await Promise.all(
    state.queries.map(async (q) => {
      // M17 定向集合：文档级 QA（docId）按文档所属集合检索，通用问答走激活集合
      const r = await hybridSearch({ text: q, vector: await embedOne(q), limit: topK, docId: c.docId, acl: c.acl, collection: c.collection ?? activeCollection() })
      if (r.mode === 'dense-fallback') mode = r.mode // 任一路退化则整体标记
      return r.hits
    })
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

  span.end(merged.map((h) => h.title), { 'retrieval.mode': mode })
  // Observation 事件：向前端汇报检索合并结果
  c.emit?.('step', {
    phase: 'observation',
    label: '检索',
    content: `查询 [${state.queries.join(' | ')}] → 合并去重后 ${merged.length} 块`,
  })
  return { hits: merged }
}

// ---- 评估结果缓存 ----
// 键 = 问题 + 有序块文本哈希（内容寻址）：增删文档会改变块集 → 键不同，天然免疫脏读；
// 命中即等价重放评估结论（省一次 LLM 评估），收益场景：同一问题跨请求重复评估
const gradeCache = new Map()
const GRADE_CACHE_MAX = 500 // FIFO 上限，重启即空（纯优化层，不影响正确性）
const gradeCacheKey = (question, hits) =>
  createHash('sha1')
    .update(
      question.trim().toLowerCase() +
        '\n' +
        hits.map((h) => createHash('sha1').update(h.text).digest('hex')).join(',')
    )
    .digest('hex')

// 评估：LLM 逐条判相关 + 判断材料是否足够（返回形状由 GRADE_SCHEMA 经 tool-call 强制）
async function gradeNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const cacheKey = gradeCacheKey(state.question, state.hits)
  const span = otelSpan('search_kb.grade', 'LLM', { 'input.value': state.question })

  let grade = gradeCache.get(cacheKey)
  const cached = !!grade
  if (cached) {
    span.end('评估缓存命中', { 'cache.hit': true })
  } else {
    try {
      const { args, usage } = await chatStructured(
        gradeMessages(state.question, state.hits),
        GRADE_SCHEMA,
        { name: 'submit_grade', description: '提交相关性评估结果', signal: c.signal }
      )
      grade = args
      span.end(args, { usage })
    } catch (e) {
      // 两轮自纠仍失败：评估器不可用，不阻断主链路 —— 全部保留，宁滥勿缺
      span.end(`评估失败: ${e.message}`, { level: 'ERROR', statusMessage: e.message })
    }
  }

  let hits = state.hits
  let enough = false
  let feedback = ''
  let conflict = false
  if (grade && Array.isArray(grade.relevant)) {
    // 正常路径：仅保留 LLM 判定为相关的编号（编号从 1 开始，对应展示序号）
    const keep = new Set(grade.relevant.map(String))
    hits = state.hits.filter((_, i) => keep.has(String(i + 1)))
    enough = grade.enough === true
    feedback = grade.reason || ''
    conflict = grade.conflict === true // M18b：相关资料间存在事实冲突
  } else {
    hits = state.hits // 评估失败兜底：全部保留
    enough = hits.length > 0 // 有结果就视为够用，避免误触发改写循环
  }

  // 缓存写入：仅真实评估结果入缓存（缓存命中回放不重复写）
  if (grade && Array.isArray(grade.relevant) && !cached) {
    gradeCache.set(cacheKey, grade)
    if (gradeCache.size > GRADE_CACHE_MAX) {
      gradeCache.delete(gradeCache.keys().next().value) // FIFO 淘汰
    }
  }

  c.emit?.('step', {
    phase: 'observation',
    label: '评估',
    content: `${cached ? '⚡ 评估（缓存命中）' : enough ? '✅ 材料充足' : '⚠️ 材料不足'}：保留 ${hits.length}/${state.hits.length}${conflict ? '；⚠ 资料存在冲突' : ''}${feedback ? `（${feedback}）` : ''}`,
  })
  // webEligible 写入状态供路由判读（路由函数保持只读 state，不读 cfg）：
  // 指定文档范围（docId）不联网兜底——用户明确限定了资料边界，混入网络内容反而污染答案
  return { hits, enough, feedback, conflict, webEligible: !c.docId && webSearchAvailable() }
}

// 改写：材料不足时换 2 个问法重检（返回形状由 REWRITE_SCHEMA 经 tool-call 强制）
async function rewriteNode(state, cfg) {
  const c = cfg?.configurable ?? {}
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
    span.end(args, { usage })
  } catch (e) {
    span.end(`改写失败: ${e.message}`, { level: 'ERROR', statusMessage: e.message })
  }

  // 清洗改写结果：字符串化 → 滤空 → 最多取 2 个；失败兜底用原问题
  const next = (queries ?? []).map(String).filter(Boolean).slice(0, 2)
  const finalQueries = next.length ? next : [state.question]
  c.emit?.('step', { phase: 'thought', label: '改写重检', content: finalQueries.join(' | ') })
  // 返回新查询词并累加尝试次数；下一轮 retrieve 将使用新 queries
  return { queries: finalQueries, attempts: state.attempts + 1 }
}

// ---- 首跳改写（ID7，QUERY_REWRITE=on 启用）：检索前把原始问题改写成更利于召回的查询 ----
// （同义扩展/关键词化/换个问法），复用 REWRITE_SCHEMA 强制形状；不计入 attempts（不消耗重试额度）；
// LLM 失败静默回退原问题，只多花一次尝试、不阻断检索
async function preRewriteNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const span = otelSpan('search_kb.pre_rewrite', 'LLM', { 'input.value': state.question })
  let queries = []
  try {
    const { args, usage } = await chatStructured(
      rewriteMessages(state.question, [], '首轮检索前的查询优化'),
      REWRITE_SCHEMA,
      { name: 'submit_rewrite', description: '提交首轮检索查询', signal: c.signal }
    )
    queries = args.queries
    span.end(args, { usage })
  } catch (e) {
    span.end(`首跳改写失败: ${e.message}`, { level: 'ERROR', statusMessage: e.message })
  }
  const next = (queries ?? []).map(String).filter(Boolean).slice(0, 2)
  const finalQueries = next.length ? next : [state.question]
  c.emit?.('step', { phase: 'thought', label: '查询优化', content: finalQueries.join(' | ') })
  return { queries: finalQueries } // attempts 不变
}

// 网络兜底：重试额度用尽仍不足 → 联网搜索一次，结果并入资料后再过一遍 grade 过滤
const hostOf = (u) => {
  try { return new URL(u).hostname } catch { return '' }
}

async function webSearchNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  c.emit?.('step', {
    phase: 'thought',
    label: '联网兜底',
    content: `知识库资料不足，联网搜索「${state.question}」`,
  })
  const results = await webSearch(state.question, { signal: c.signal, count: config.webSearch.maxResults })
  c.emit?.('step', {
    phase: 'observation',
    label: '联网搜索',
    content: results.length
      ? `命中 ${results.length} 条网络结果，与库内资料合并后重新评估`
      : '网络搜索无结果或失败，基于已有资料/通用知识回答',
  })
  // 网络结果转成与知识库块同形的 hit：docId='web:URL' 保证引用键全局唯一（citeMap/合并不碰撞）；
  // score 置 0（无相似度语义，前端不展示），url 字段标识网络来源
  const webHits = results.map((r) => ({
    docId: `web:${r.url}`,
    chunkIndex: 0,
    url: r.url,
    title: r.title,
    text: r.snippet,
    filename: hostOf(r.url),
    score: 0,
  }))
  return { webTried: true, hits: [...state.hits, ...webHits] }
}

// 条件路由（只读 state，不读 cfg；webEligible 已由 gradeNode 写入状态）：
//   足够 → END；不足且有重试额度 → rewrite；额度用尽且未联网兜底 → web_search；否则 END
// searchMaxAttempts 默认 2，即最多"改写→重检"2 次，防止无限循环烧 token
const shouldRetry = (state) => {
  if (state.enough) return END
  if (state.attempts < config.agent.searchMaxAttempts) return 'rewrite'
  if (state.webEligible && !state.webTried) return 'web_search'
  return END
}

// ---- 编译子图：START →（可选首跳改写）→ retrieve → grade →（条件）rewrite / web_search → grade → END ----
export const searchGraph = new StateGraph(SearchState)
  .addNode('retrieve', retrieveNode)
  .addNode('grade', gradeNode)
  .addNode('rewrite', rewriteNode)
  .addNode('web_search', webSearchNode)
  .addNode('pre_rewrite', preRewriteNode)
  .addConditionalEdges(START, () => (config.agent.queryRewrite ? 'pre_rewrite' : 'retrieve')) // ID7 开关
  .addEdge('pre_rewrite', 'retrieve')
  .addEdge('retrieve', 'grade')
  .addConditionalEdges('grade', shouldRetry)
  .addEdge('rewrite', 'retrieve')
  .addEdge('web_search', 'grade') // 网络结果并入资料后复用评估节点过滤
  .compile()
