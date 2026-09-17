// ============================================================================
// Langfuse score 回填（M13）：把评估/回归结果写回 Langfuse 形成质量看板
// ----------------------------------------------------------------------------
// 两种写入：
//   lfScoreTrace  单 trace 打分（traceId 来自 chat done 事件 → backend rootSpan）
//                 POST /api/public/scores
//   lfRunSummary  运行汇总：ingestion 批量建一条 run trace + 挂聚合分
//                 POST /api/public/ingestion（trace-create + score-create）
// 约定：LANGFUSE_* 未配置 → 全部 no-op；网络失败 → warn 不抛（观测失败不伤评估主流程）
// 429/5xx 重试（最多 3 次尝试）：429 遵循服务端 retryAfterSeconds（上限 65s），5xx 指数退避
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..') // scripts/lib → 项目根

// 读配置：环境变量优先，其次 backend/.env（与 evaluate.mjs 的 loadBackendEnv 同源语义）
function loadCfg() {
  let host = process.env.LANGFUSE_HOST || ''
  let pk = process.env.LANGFUSE_PUBLIC_KEY || ''
  let sk = process.env.LANGFUSE_SECRET_KEY || ''
  const p = join(ROOT, 'backend/.env')
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^(LANGFUSE_(HOST|PUBLIC_KEY|SECRET_KEY))\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const v = m[3].replace(/^["']|["']$/g, '')
      if (m[1] === 'LANGFUSE_HOST') host ||= v
      if (m[1] === 'LANGFUSE_PUBLIC_KEY') pk ||= v
      if (m[1] === 'LANGFUSE_SECRET_KEY') sk ||= v
    }
  }
  if (!host || !pk || !sk) return null
  return { host: host.replace(/\/+$/, ''), auth: 'Basic ' + Buffer.from(`${pk}:${sk}`).toString('base64') }
}

let CFG // 进程内缓存一次
export function lfInit() {
  CFG ??= loadCfg()
  return CFG
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(url, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: CFG.auth },
      body: JSON.stringify(body),
    })
    if (r.ok) return
    const text = await r.text()
    if (attempt >= 2 || (r.status !== 429 && r.status < 500)) {
      throw new Error(`Langfuse HTTP ${r.status}: ${text.slice(0, 150)}`)
    }
    // 429 按服务端 retryAfterSeconds 等待（上限 65s）；5xx 指数退避 500ms/1s
    const wait = r.status === 429
      ? Math.min((Number(text.match(/"retryAfterSeconds":(\d+)/)?.[1]) || 5) * 1000 + 500, 65_000)
      : 500 * 2 ** attempt
    await sleep(wait)
  }
}

/** 单 trace 打分：traceId 为空（观测未启用/检索层无 trace）时静默跳过 */
export async function lfScoreTrace(traceId, name, value, { dataType = 'NUMERIC', comment = '' } = {}) {
  if (!lfInit() || !traceId) return
  try {
    await post(`${CFG.host}/api/public/scores`, {
      traceId, name, value, dataType, comment: comment.slice(0, 500),
    })
  } catch (e) {
    console.warn(`[lf] score 回填失败(${name}): ${e.message}`)
  }
}

/** 运行汇总 trace + 聚合分（scores: [{name, value, comment?, dataType?}]） */
export async function lfRunSummary({ name, metadata = {}, scores = [] }) {
  if (!lfInit() || !scores.length) return
  try {
    const traceId = crypto.randomUUID()
    const now = new Date().toISOString()
    const batch = [
      { id: crypto.randomUUID(), type: 'trace-create', traceId, name, timestamp: now, metadata },
      ...scores.map((s) => ({
        id: crypto.randomUUID(),
        type: 'score-create',
        traceId,
        name: s.name,
        value: s.value,
        dataType: s.dataType ?? 'NUMERIC',
        comment: (s.comment ?? '').slice(0, 500),
      })),
    ]
    await post(`${CFG.host}/api/public/ingestion`, { batch })
    console.log(`[lf] 运行汇总已回填: ${name}（${scores.length} 项分数）`)
  } catch (e) {
    console.warn(`[lf] 运行汇总回填失败: ${e.message}`)
  }
}
