// ============================================================================
// 评估 runner：量化检索与答案质量（M6）—— 与回归（行为红线）互补的质量水位标尺
// ----------------------------------------------------------------------------
// 用法：
//   node scripts/evaluate.mjs                          # 全量（检索 + 答案两层）
//   node scripts/evaluate.mjs --layer retrieval        # 只跑检索层（零 LLM 成本，秒级）
//   node scripts/evaluate.mjs --baseline evals/results/x.json   # 与基线对比
//   node scripts/evaluate.mjs --layer retrieval --assert "recall>=0.85,mrr>=0.7,purity=1"  # 阈值门禁（CI）
//   node scripts/evaluate.mjs --detail                 # 逐题明细（失分归因定位）
// 数据：evals/golden.jsonl（34 题）+ evals/fixtures/*（8 文档，自动上传，幂等）
// 指标：
//   检索层  recall@k = 期望特征被 topK 命中覆盖的比例；MRR = 首个期望块排名倒数；
//           purity = 负向断言（expect_none 干扰关键词不得出现在命中里）通过率
//   答案层  mustOk = 硬事实（answer_must 子串）必含率；faithfulness/relevance = LLM judge 0~1
// 产物：evals/results/<时间戳>.json（逐题明细 + 汇总），终端打印汇总表与 diff
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.BASE_URL || 'http://localhost:8788'
const AUTH_USER = process.env.AUTH_USER || 'demo'
const AUTH_PASS = process.env.AUTH_PASS || 'demo123'

// ---- 参数解析 ----
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const LAYER = arg('--layer', 'all') // all | retrieval | answer
const BASELINE = arg('--baseline', null)
const TOPK = Number(arg('--topK', 5))
const DETAIL = argv.includes('--detail') // 逐题明细打印（失分归因定位用）
// 阈值门禁（CI 用），如 --assert "recall>=0.85,mrr>=0.7,purity=1"，任一不达标退出码 1
const ASSERT = arg('--assert', null)

if (!['all', 'retrieval', 'answer'].includes(LAYER)) {
  console.error('--layer 只支持 all | retrieval | answer')
  process.exit(2)
}

// ---- 鉴权 ----
let TOKEN = ''
async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  })
  if (!r.ok) throw new Error(`登录失败 HTTP ${r.status}`)
  TOKEN = (await r.json()).token
}
const authHeaders = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra })

// ---- SSE 客户端（与 regression.mjs 同款）----
async function chat({ question, sessionId, topK = TOPK }) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ question, sessionId, topK }),
  })
  if (!res.ok && res.status !== 200) throw new Error(`chat HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const out = { answer: '', sources: [], steps: [], usage: null, done: null }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let ev = null, data = null
      for (const l of frame.split('\n')) {
        if (l.startsWith('event: ')) ev = l.slice(7)
        else if (l.startsWith('data: ')) { try { data = JSON.parse(l.slice(6)) } catch { } }
      }
      if (!ev) continue
      if (ev === 'delta') out.answer += data.text ?? ''
      else if (ev === 'sources') out.sources = data.sources
      else if (ev === 'usage') out.usage = data
      else if (ev === 'step') out.steps.push(data)
      else if (ev === 'done') out.done = data
      else if (ev === 'error') throw new Error(data?.message || 'chat error')
    }
  }
  return out
}

// ---- fixture 上传（幂等）：evals/fixtures/* 逐个入队，等全部就绪 ----
async function ensureFixtures() {
  const dir = join(ROOT, 'evals/fixtures')
  const files = readdirSync(dir).filter((f) => /\.(md|txt)$/.test(f))
  console.log(`fixture: ${files.length} 个文档`)
  for (const f of files) {
    const fd = new FormData()
    fd.append('file', new Blob([readFileSync(join(dir, f))]), f)
    fd.append('classification', 'public') // M10 RBAC：评估语料对所有用户可读（新上传默认 private）
    const r = await fetch(`${BASE}/api/documents`, { method: 'POST', headers: authHeaders(), body: fd })
    if (r.ok) {
      const j = await r.json().catch(() => ({}))
      if (!j.duplicated) console.log(`  入队: ${f}`)
    } else if (r.status !== 409) {
      throw new Error(`上传失败 ${f}: HTTP ${r.status}`)
    }
  }
  for (let i = 0; i < 90; i++) {
    const docs = await (await fetch(`${BASE}/api/documents`, { headers: authHeaders() })).json()
    const mine = docs.filter((d) => files.includes(d.filename))
    if (mine.length && mine.every((d) => d.status === 'ready' || d.status === 'failed')) {
      const failed = mine.filter((d) => d.status === 'failed')
      if (failed.length) throw new Error(`fixture 摄取失败: ${failed.map((d) => d.filename).join(',')}`)
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('fixture 摄取超时（90s）')
}

// ---- LLM judge：直调 DeepSeek（评估脚本独立于服务运行时，不复用 backend/llm.js）----
function loadBackendEnv() {
  const p = join(ROOT, 'backend/.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
const judgeLLM = (() => {
  loadBackendEnv()
  const key = process.env.LLM_API_KEY
  const url = `${process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1'}/chat/completions`
  const model = process.env.LLM_MODEL || 'deepseek-chat'
  if (!key) return null
  return async (messages) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, temperature: 0 }),
    })
    if (!r.ok) throw new Error(`judge LLM HTTP ${r.status}`)
    const j = await r.json()
    return JSON.parse(j.choices[0].message.content)
  }
})()

const faithfulnessPrompt = (answer, sources) => [
  { role: 'system', content: '你是严格的答案忠实度评估器。判断「回答」中的每个事实性论断是否都能在「参考资料」中找到依据。回答里来自通用知识且参考资料未覆盖的内容，算作不忠实（unfaithful）。注意：来源的标题/文件名属于资料元信息，答案引用它们不算不忠实。只输出 JSON。' },
  { role: 'user', content: `参考资料：\n${sources.map((s, i) => `[${i + 1}] ${s.filename || ''}${s.title ? ' · ' + s.title : ''}\n${s.text?.slice(0, 500)}`).join('\n') || '(无来源)'}\n\n回答：\n${answer}\n\n输出 {"score": 0到1的小数, "issues": ["不忠实论断列表"]}` },
]
const relevancePrompt = (question, answer) => [
  { role: 'system', content: '你是答案相关性评估器。判断「回答」是否真正回应了「问题」所问的内容（跑题、答非所问、空洞泛泛都算低分）。只输出 JSON。' },
  { role: 'user', content: `问题：${question}\n\n回答：${answer}\n\n输出 {"score": 0到1的小数, "reason": "一句话理由"}` },
]

// ---- 第 1 层：检索质量（裸检索，零 LLM）----
async function runRetrieval(items) {
  const rows = []
  for (const it of items) {
    const r = await (await fetch(`${BASE}/api/debug/retrieval?q=${encodeURIComponent(it.question)}&topK=${it.topK || TOPK}`, { headers: authHeaders() })).json()
    if (!r.hits) throw new Error(`检索失败: ${it.question}`)
    const blob = (h) => `${h.title ?? ''}\n${h.text ?? ''}`
    const covered = (it.expect ?? []).filter((k) => r.hits.some((h) => blob(h).includes(k)))
    const firstRank = r.hits.findIndex((h) => (it.expect ?? []).some((k) => blob(h).includes(k)))
    const noneHits = (it.expect_none ?? []).filter((k) => r.hits.some((h) => blob(h).includes(k)))
    rows.push({
      question: it.question,
      note: it.note ?? '',
      recall: (it.expect ?? []).length ? +(covered.length / it.expect.length).toFixed(3) : 1,
      mrr: firstRank >= 0 ? +(1 / (firstRank + 1)).toFixed(3) : 0,
      noneViolations: noneHits, // 非空 = 干扰块混入
      expect: it.expect ?? [],
      covered,
      top: r.hits[0] ? `${r.hits[0].title}(${r.hits[0].filename})` : '(无命中)',
      hits: r.hits.map((h) => `${h.title}|${h.text.slice(0, 60)}`),
    })
    process.stdout.write(`  [${rows.length}/${items.length}] recall=${rows.at(-1).recall} mrr=${rows.at(-1).mrr} ${it.question.slice(0, 22)}\n`)
  }
  const summary = {
    recall: +avg(rows.map((r) => r.recall)).toFixed(3),
    mrr: +avg(rows.map((r) => r.mrr)).toFixed(3),
    purity: +avg(rows.map((r) => (r.noneViolations.length ? 0 : 1))).toFixed(3),
    perfectCount: rows.filter((r) => r.recall === 1 && !r.noneViolations.length).length,
  }
  return { summary, rows }
}

// ---- 第 2 层：答案质量（完整 Agent 链路 + judge）----
async function runAnswer(items) {
  const rows = []
  for (const it of items) {
    const r = await chat({ question: it.question })
    const mustOk = (it.answer_must ?? []).every((k) => r.answer.includes(k))
    let faith = null, rel = null
    if (judgeLLM) {
      try {
        faith = await judgeLLM(faithfulnessPrompt(r.answer, r.sources))
      } catch (e) { console.warn(`  judge(faith) 失败: ${e.message}`) }
      try {
        rel = await judgeLLM(relevancePrompt(it.question, r.answer))
      } catch (e) { console.warn(`  judge(rel) 失败: ${e.message}`) }
    }
    rows.push({
      question: it.question,
      answer: r.answer,
      mustOk,
      missingMust: (it.answer_must ?? []).filter((k) => !r.answer.includes(k)),
      faithfulness: faith?.score ?? null,
      faithIssues: faith?.issues ?? [],
      relevance: rel?.score ?? null,
      relReason: rel?.reason ?? '',
      tokens: r.usage?.totalTokens ?? null,
      elapsedSec: r.usage?.elapsedSec ?? null,
      stopReason: r.done?.stopReason ?? '?',
    })
    process.stdout.write(`  [${rows.length}/${items.length}] must=${mustOk ? 'Y' : 'N'} faith=${faith?.score ?? '-'} rel=${rel?.score ?? '-'} ${it.question.slice(0, 22)}\n`)
  }
  const faiths = rows.map((r) => r.faithfulness).filter((v) => v != null)
  const rels = rows.map((r) => r.relevance).filter((v) => v != null)
  const summary = {
    count: rows.length,
    mustOkRate: rows.length ? +avg(rows.map((r) => (r.mustOk ? 1 : 0))).toFixed(3) : null,
    faithfulness: faiths.length ? +avg(faiths).toFixed(3) : null,
    relevance: rels.length ? +avg(rels).toFixed(3) : null,
    totalTokens: rows.reduce((a, r) => a + (r.tokens ?? 0), 0),
  }
  return { summary, rows }
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

// ---- 主流程 ----
const t0 = Date.now()
await login()
console.log(`已登录: ${AUTH_USER} @ ${BASE} | layer=${LAYER} topK=${TOPK}\n`)
await ensureFixtures()

const golden = readFileSync(join(ROOT, 'evals/golden.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

const result = { meta: { ts: new Date().toISOString(), base: BASE, layer: LAYER, topK: TOPK, user: AUTH_USER } }

if (LAYER !== 'answer') {
  console.log('\n== 检索层（裸检索，零 LLM）==')
  result.retrieval = await runRetrieval(golden)
  const s = result.retrieval.summary
  console.log(`recall@${TOPK}=${s.recall}  MRR=${s.mrr}  purity=${s.purity}  全对题数=${s.perfectCount}/${golden.length}`)
}
if (LAYER !== 'retrieval') {
  const items = golden.filter((it) => it.answer_must) // 带 answer_must 的题才跑答案层
  console.log(`\n== 答案层（完整 Agent + LLM judge，${items.length} 题）==`)
  result.answer = await runAnswer(items)
  const s = result.answer.summary
  console.log(`mustOkRate=${s.mustOkRate}  faithfulness=${s.faithfulness}  relevance=${s.relevance}  tokens=${s.totalTokens}`)
}

// 存档 + 基线对比
mkdirSync(join(ROOT, 'evals/results'), { recursive: true })
const outPath = join(ROOT, 'evals/results', `${Date.now()}-${LAYER}.json`)
writeFileSync(outPath, JSON.stringify(result, null, 2))
console.log(`\n结果已存档: ${outPath}`)

if (BASELINE) {
  const bp = existsSync(BASELINE) ? BASELINE : join(ROOT, BASELINE) // 相对路径按项目根解析
  const b = JSON.parse(readFileSync(bp, 'utf8'))
  console.log(`\n== 与基线对比（${basename(BASELINE)}）==`)
  const row = (name, cur, old) => {
    if (old == null || cur == null) return console.log(`  ${name}: ${cur ?? '-'}（基线无值）`)
    const d = +(cur - old).toFixed(3)
    const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '→'
    console.log(`  ${name}: ${old} → ${cur}  ${arrow} ${d >= 0 ? '+' : ''}${d}`)
  }
  if (result.retrieval && b.retrieval) {
    row('recall', result.retrieval.summary.recall, b.retrieval.summary.recall)
    row('MRR', result.retrieval.summary.mrr, b.retrieval.summary.mrr)
    row('purity', result.retrieval.summary.purity, b.retrieval.summary.purity)
  }
  if (result.answer && b.answer) {
    row('mustOkRate', result.answer.summary.mustOkRate, b.answer.summary.mustOkRate)
    row('faithfulness', result.answer.summary.faithfulness, b.answer.summary.faithfulness)
    row('relevance', result.answer.summary.relevance, b.answer.summary.relevance)
  }
}

// 失败明细提示（评估是度量不是门禁，只提示不改变退出码）
const badR = (result.retrieval?.rows ?? []).filter((r) => r.recall < 1 || r.noneViolations.length)
const badA = (result.answer?.rows ?? []).filter((r) => !r.mustOk || (r.faithfulness != null && r.faithfulness < 0.8))
if (badR.length + badA.length) {
  console.log(`\n⚠ 未达满分 ${badR.length + badA.length} 题：`)
  for (const r of badR) console.log(`  [检索] ${r.question} → recall=${r.recall}${r.noneViolations.length ? ` 混入:${r.noneViolations.join(',')}` : ''} top=${r.top}`)
  for (const r of badA) {
    console.log(`  [答案] ${r.question} → 缺: ${r.missingMust.join(',') || '(mustOk 达标)'} faith=${r.faithfulness ?? '-'} rel=${r.relevance ?? '-'}`)
    if (r.faithIssues?.length) console.log(`    忠实度问题: ${r.faithIssues.join('；')}`)
    if (r.relReason) console.log(`    相关性评语: ${r.relReason}`)
  }
}

// --detail：逐题全量明细（检索层含期望覆盖/命中列表；答案层含 judge 逐项），归因定位用
if (DETAIL) {
  if (result.retrieval) {
    console.log('\n== 检索层逐题明细 ==')
    for (const r of result.retrieval.rows) {
      const missed = r.expect.filter((k) => !r.covered.includes(k))
      console.log(`[检索] recall=${r.recall} mrr=${r.mrr} ${r.question}`)
      console.log(`  期望缺失: ${missed.join(', ') || '-'} ｜ 干扰混入: ${r.noneViolations.join(', ') || '-'} ｜ top1: ${r.top}`)
      console.log(`  命中: ${r.hits.join(' / ')}`)
    }
  }
  if (result.answer) {
    console.log('\n== 答案层逐题明细 ==')
    for (const r of result.answer.rows) {
      console.log(`[答案] must=${r.mustOk ? 'Y' : 'N'} faith=${r.faithfulness ?? '-'} rel=${r.relevance ?? '-'} ${r.question}`)
      console.log(`  缺硬事实: ${r.missingMust.join(', ') || '-'} ｜ stopReason: ${r.stopReason} ｜ tokens: ${r.tokens ?? '-'}`)
      if (r.faithIssues?.length) console.log(`  忠实度问题: ${r.faithIssues.join('；')}`)
      if (r.relReason) console.log(`  相关性评语: ${r.relReason}`)
    }
  }
}

// 忠实度失分归因汇总：所有 judge 指出的问题按出现频次排序，指导提示词/检索的修复方向
const allIssues = (result.answer?.rows ?? []).flatMap((r) => r.faithIssues ?? [])
if (allIssues.length) {
  const freq = {}
  for (const s of allIssues) freq[s] = (freq[s] ?? 0) + 1
  console.log('\n== 忠实度失分归因（按频次）==')
  for (const [s, n] of Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ×${n} ${s}`)
  }
}

// --assert：阈值门禁（CI 用），任一断言不达标退出码 1
if (ASSERT) {
  const metrics = {
    ...(result.retrieval
      ? { recall: result.retrieval.summary.recall, mrr: result.retrieval.summary.mrr, purity: result.retrieval.summary.purity }
      : {}),
    ...(result.answer
      ? { mustOk: result.answer.summary.mustOkRate, faithfulness: result.answer.summary.faithfulness, relevance: result.answer.summary.relevance }
      : {}),
  }
  const fails = []
  console.log('\n== 阈值断言 ==')
  for (const cond of ASSERT.split(',')) {
    const m = cond.trim().match(/^(recall|mrr|purity|mustOk|faithfulness|relevance)\s*(>=|<=|>|<|=)\s*([\d.]+)$/)
    if (!m) { fails.push(`断言格式非法: ${cond}`); continue }
    const v = metrics[m[1]]
    const t = Number(m[3])
    if (v == null) { console.log(`  ${m[1]} ${m[2]} ${t} → 无值 ❌`); fails.push(`${m[1]} 无值`); continue }
    const op = { '>=': v >= t, '<=': v <= t, '>': v > t, '<': v < t, '=': Math.abs(v - t) < 1e-9 }[m[2]]
    console.log(`  ${m[1]} ${m[2]} ${t} → 实际 ${v} ${op ? '✅' : '❌'}`)
    if (!op) fails.push(cond.trim())
  }
  if (fails.length) {
    console.error(`阈值断言未通过: ${fails.join(', ')}`)
    process.exit(1)
  }
}
console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
