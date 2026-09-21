// ============================================================================
// 领域语料 seed（M21）：backend/src/domain/<激活包>/evals/fixtures → rag_<pack> 集合
// ----------------------------------------------------------------------------
// 用法：DOMAIN_PACKS=company-policy node scripts/seed-domain.mjs   （未设时默认 api-docs）
// 幂等：内容 hash 未变时服务端去重跳过，重跑安全；sidecar <f>.json 携带版本元数据
//       （docKey/docVersion/effectiveDate/deprecated，M18 上传链路语义）。
// 服务需以相同 DOMAIN_PACKS 启动（集合白名单 allowedCollections 校验）。
// ============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.BASE_URL || 'http://localhost:8788'
const AUTH_USER = process.env.AUTH_USER || 'demo'
const AUTH_PASS = process.env.AUTH_PASS || 'demo123'
const PACK = (process.env.DOMAIN_PACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean)[0] ?? 'api-docs'
const DIR = join(ROOT, `backend/src/domain/${PACK}/evals/fixtures`)
const COLLECTION = `rag_${PACK.replace(/-/g, '_')}`

let TOKEN = ''
const authHeaders = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra })

async function main() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  })
  if (!r.ok) throw new Error(`登录失败 HTTP ${r.status}`)
  TOKEN = (await r.json()).token
  console.log(`已登录: ${AUTH_USER} @ ${BASE} | pack=${PACK} → ${COLLECTION}`)

  const files = readdirSync(DIR).filter((f) => /\.(md|txt|pdf|docx|png|jpg|jpeg|webp)$/.test(f))
  console.log(`seed[${PACK}]: ${files.length} 个文档`)
  for (const f of files) {
    const fd = new FormData()
    fd.append('file', new Blob([readFileSync(join(DIR, f))]), f)
    fd.append('classification', 'public')
    fd.append('collection', COLLECTION)
    // sidecar 元数据：与 evaluate.mjs ensureFixtures 同语义
    const sidecar = join(DIR, `${f}.json`)
    if (existsSync(sidecar)) {
      const meta = JSON.parse(readFileSync(sidecar, 'utf8'))
      for (const k of ['docKey', 'effectiveDate', 'deprecated']) if (meta[k] != null && meta[k] !== '') fd.append(k, String(meta[k]))
      if (meta.docVersion != null) fd.append('docVersion', String(meta.docVersion))
    }
    const r2 = await fetch(`${BASE}/api/documents`, { method: 'POST', headers: authHeaders(), body: fd })
    if (r2.ok) {
      const j = await r2.json().catch(() => ({}))
      if (!j.duplicated) console.log(`  入队: ${f}`)
    } else if (r2.status !== 409) {
      throw new Error(`上传失败 ${f}: HTTP ${r2.status} ${await r2.text().catch(() => '')}`)
    }
  }

  for (let i = 0; i < 90; i++) {
    const docs = await (await fetch(`${BASE}/api/documents`, { headers: authHeaders() })).json()
    const mine = docs.filter((d) => files.includes(d.filename) && d.collection === COLLECTION)
    if (mine.length && mine.every((d) => d.status === 'ready' || d.status === 'failed')) {
      const failed = mine.filter((d) => d.status === 'failed')
      if (failed.length) throw new Error(`摄取失败: ${failed.map((d) => d.filename).join(',')}`)
      console.log('全部就绪')
      return
    }
    await new Promise((r3) => setTimeout(r3, 1500))
  }
  throw new Error('摄取超时（135s）')
}

main().catch((e) => { console.error(e.message); process.exit(1) })
