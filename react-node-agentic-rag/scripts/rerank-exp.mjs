// ============================================================================
// M8 rerank 实验：服务端融合算法/召回池/精排 消融对比（零 LLM，纯检索层）
// ----------------------------------------------------------------------------
// 靶子：竞争文档歧义题 Q1（mrr=0.5）——旧版基线文档块挤进前排
// 组合：rrf(基线) / rrf+大池 / dbsf / dbsf+大池 / rrf+dense-rescore
// 指标：recall@5（任一期望关键词进前5）、MRR（首个命中块倒数排名）、Q1 排名、时延
// 用法：cd backend && node ../scripts/rerank-exp.mjs
// ============================================================================

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { hybridSearch } from '../backend/src/rag/qdrant.js'
import { embed } from '../backend/src/rag/embedder.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cases = readFileSync(path.join(root, 'evals/golden.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

// 命中判定：任一期望关键词出现在块的标题或正文中（与 evaluate.mjs 检索层同语义）
const hitChunk = (c, kws) => kws.some((kw) => `${c.title ?? ''}${c.text}`.includes(kw))

const variants = [
  { name: 'rrf(基线)', opts: {} },
  { name: 'rrf+池x8', opts: { prefetchMul: 8 } },
  { name: 'dbsf', opts: { fusion: 'dbsf' } },
  { name: 'dbsf+池x8', opts: { fusion: 'dbsf', prefetchMul: 8 } },
  { name: 'rrf+dense精排', opts: { rerank: 'dense', prefetchMul: 8 } },
]

const vectors = await embed(cases.map((c) => c.question))
console.log(`\n${cases.length} 题 × ${variants.length} 组合\n`)

const rows = []
for (const v of variants) {
  let rrSum = 0, hit5 = 0, ms = 0
  const perCase = []
  const fails = []
  for (let i = 0; i < cases.length; i++) {
    const t0 = performance.now()
    let hits, mode
    try {
      ;({ hits, mode } = await hybridSearch({ text: cases[i].question, vector: vectors[i], limit: 5, ...v.opts }))
    } catch (e) {
      // 实验不容静默退化：主查询失败直接报出服务端 detail 与定位信息
      console.error(`[${v.name}] 第${i + 1}题「${cases[i].question}」主查询失败:`,
        JSON.stringify(e?.data?.status?.error ?? e.message))
      process.exit(1)
    }
    ms += performance.now() - t0
    if (mode === 'dense-fallback') fails.push(`Q${i + 1}「${cases[i].question.slice(0, 20)}」`)
    const first = hits.findIndex((h) => hitChunk(h, cases[i].expect))
    const rr = first < 0 ? 0 : 1 / (first + 1)
    rrSum += rr
    if (first >= 0 && first < 5) hit5++
    perCase.push({ q: cases[i].question.slice(0, 18), rr, n: hits.length, mode })
  }
  if (fails.length) console.log(`  ⚠️ [${v.name}] ${fails.length} 题退化纯稠密: ${fails.join(' ')}`)
  rows.push({
    name: v.name,
    recall5: (hit5 / cases.length).toFixed(3),
    mrr: (rrSum / cases.length).toFixed(3),
    avgMs: Math.round(ms / cases.length),
    perCase,
  })
}

console.log('配置             recall@5   MRR    平均时延')
for (const r of rows) console.log(`${r.name.padEnd(14)} ${r.recall5.padEnd(9)} ${r.mrr.padEnd(7)} ${r.avgMs}ms`)

// Q1（歧义题）逐组合排名详情
console.log('\n== Q1 详情（靶子：基线 mrr=0.5）==')
for (const v of variants) {
  const { hits } = await hybridSearch({ text: cases[0].question, vector: vectors[0], limit: 5, ...v.opts })
  const first = hits.findIndex((h) => hitChunk(h, cases[0].expect))
  console.log(`${v.name.padEnd(14)} rr=${first < 0 ? 0 : (1 / (first + 1)).toFixed(2)} | ${hits
    .map((h, i) => `${i + 1}.${h.filename}:${h.chunkIndex}${hitChunk(h, cases[0].expect) ? '✓' : ''}`)
    .join(' ')}`)
}
