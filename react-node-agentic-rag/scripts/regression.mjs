// 坏用例回归脚本：对活服务跑一批「坏用例」，断言 Agent 行为不回退
// 用法：先 start.sh 起服务，然后 node scripts/regression.mjs（BASE_URL 可覆盖）
// 鉴权：M5 起接口需 JWT——默认以 demo/demo123 登录，可用 AUTH_USER/AUTH_PASS 覆盖
// 退出码：全过 0，有失败 1 —— 可挂 CI
const BASE = process.env.BASE_URL || 'http://localhost:8788'
const AUTH_USER = process.env.AUTH_USER || 'demo'
const AUTH_PASS = process.env.AUTH_PASS || 'demo123'
import { lfScoreTrace, lfRunSummary } from './lib/lf-scores.mjs'

// ---------- 鉴权 ----------
let TOKEN = ''
async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  })
  if (!r.ok) throw new Error(`登录失败 HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`)
  TOKEN = (await r.json()).token
}
const authHeaders = () => ({ authorization: `Bearer ${TOKEN}` })

// ---------- SSE 客户端 ----------
async function chat({ question, sessionId, topK = 5 }) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ question, sessionId, topK }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const out = { answer: '', sources: [], steps: [], usage: null, done: null }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop()
    for (const frame of frames) {
      let ev = null
      const dataLines = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!ev) continue
      const d = JSON.parse(dataLines.join('\n'))
      if (ev === 'delta') out.answer += d.text
      else if (ev === 'sources') out.sources = d.sources
      else if (ev === 'step') out.steps.push(d)
      else if (ev === 'usage') out.usage = d
      else if (ev === 'done') out.done = d
      else if (ev === 'error') throw new Error(d.message)
    }
  }
  return out
}

// ---------- 用例集 ----------
// fixture：脚本自带的确定性知识库文档（上传幂等，重复跑不受影响）
const FIXTURE = `# 回归测试文档

## 预算控制机制

Agentic RAG 系统设置最大工具调用轮数为 6，超限后强制模型基于已有资料作答，防止死循环烧钱。

## 检索策略

采用 CRAG 模式：先检索再由 LLM 逐条评估相关性，材料不足时改写查询重试，最多尝试 2 次。
`

async function uploadFixture() {
  const fd = new FormData()
  fd.append('file', new Blob([FIXTURE]), 'regression-fixture.md')
  fd.append('classification', 'public') // M10 RBAC：回归语料对所有用户可读
  const r = await fetch(`${BASE}/api/documents`, { method: 'POST', headers: authHeaders(), body: fd })
  if (!r.ok && r.status !== 409) throw new Error(`上传失败 HTTP ${r.status}`)
  // 等摄取完成（最多 60s）
  for (let i = 0; i < 60; i++) {
    const docs = await (await fetch(`${BASE}/api/documents`, { headers: authHeaders() })).json()
    const d = docs.find((x) => x.filename === 'regression-fixture.md')
    if (d?.status === 'ready') return
    if (d?.status === 'failed') throw new Error(`fixture 摄取失败: ${d.error}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('fixture 摄取超时')
}

const cases = [
  {
    name: '知识库命中：预算机制',
    q: '预算超限后会发生什么？',
    check: (r) => {
      ok(r.sources.length > 0, '应命中来源')
      ok(r.answer.includes('强制'), '答案应包含「强制」')
    },
  },
  {
    name: '混合检索：关键词字面命中（CRAG）',
    q: 'CRAG 是什么模式的检索？',
    check: (r) => {
      ok(r.sources.length > 0, '应命中来源')
      ok(/CRAG|评估|改写/.test(r.answer), `答案应提及 CRAG/评估/改写，实际: ${r.answer.slice(0, 80)}`)
    },
  },
  {
    name: '知识库命中：检索策略',
    q: '系统的检索策略是什么样的？',
    check: (r) => {
      ok(r.sources.length > 0, '应命中来源')
      ok(/评估|改写|CRAG/.test(r.answer), '答案应提及评估/改写/CRAG')
    },
  },
  {
    name: '工具调用：计算器',
    q: '请帮我计算 128 乘以 765 等于多少',
    check: (r) => {
      ok(
        r.steps.some((s) => s.phase === 'action' && s.label === 'calculator'),
        '应调用 calculator 工具'
      )
      ok(r.answer.includes('97920'), `答案应含 97920，实际: ${r.answer.slice(0, 80)}`)
    },
  },
  {
    name: '知识库外：不编造引用',
    q: '请用一句话介绍量子纠缠',
    check: (r) => {
      ok(r.answer.length > 5, '应给出回答')
      // 网络兜底来源带 url，属真实资料引用，无需「通用知识」标注；仅库内资料需注明
      if (r.sources.length > 0 && !r.sources.some((s) => s.url)) {
        ok(/通用知识|知识库/.test(r.answer), '引用来源时必须注明非知识库内容')
      }
    },
  },
  {
    name: '幻觉探针：问不存在的功能',
    q: '这个系统的语音识别功能是怎么实现的？',
    check: (r) => {
      ok(r.answer.length > 0, '应给出回答')
      ok(!/语音识别功能由.*框架实现/.test(r.answer), '不应编造具体实现细节')
    },
  },
]

// ---------- 断言执行 ----------
let pass = 0
const failures = []
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

console.log(`\n== Agentic RAG 回归测试 → ${BASE} ==\n`)

try {
  await login()
  console.log(`已登录: ${AUTH_USER}\n`)
  await uploadFixture()
  console.log('fixture 就绪\n')
} catch (e) {
  console.error(`fixture 上传失败: ${e.message}`)
  process.exit(1)
}

for (const c of cases) {
  const t0 = Date.now()
  let r = null
  try {
    r = await chat({ question: c.q })
    c.check(r)
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    pass++
    console.log(`✅ ${c.name}（${sec}s，来源 ${r.sources.length}，轮次 ${r.usage?.rounds ?? '?'}）`)
  } catch (e) {
    failures.push(c.name)
    console.log(`❌ ${c.name} → ${e.message}`)
  }
  // 逐用例分数回填 Langfuse（traceId 缺失=观测未启用 → 跳过；失败不伤回归主流程）
  await lfScoreTrace(r?.done?.traceId, 'regression.pass', r && !failures.includes(c.name) ? 1 : 0, {
    dataType: 'BOOLEAN',
    comment: c.name,
  })
}

console.log(`\n结果: ${pass}/${cases.length} 通过${failures.length ? `，失败: ${failures.join('、')}` : ''}\n`)

// 运行汇总回填：一条 run trace 挂通过率（未配置 LANGFUSE_* 时 no-op）
await lfRunSummary({
  name: 'regression',
  metadata: { base: BASE, total: cases.length, failures },
  scores: [{ name: 'regression.pass_rate', value: +(pass / cases.length).toFixed(3) }],
})
process.exit(failures.length ? 1 : 0)
