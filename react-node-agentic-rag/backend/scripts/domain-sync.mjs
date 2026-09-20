// ============================================================================
// 领域包手动同步脚本（M17）：node scripts/domain-sync.mjs
// ----------------------------------------------------------------------------
// 进程内直连 pg/qdrant 跑一次 connector.syncOnce()，插 pending 行后退出；
// 服务进程的摄取 worker 3s 兜底轮询会自动消费（跨进程安全，无需唤醒）。
// 定时同步由 server.js 按 DOMAIN_SYNC_INTERVAL_MIN 注册，本脚本用于首次灌库/手动补数。
// ============================================================================

import 'dotenv/config'
import { syncOnce } from '../src/domain/api-docs/connector.js'
import { schemaReady } from '../src/store/pg.js'

await schemaReady // 建表/加列先于任何查询（迁移兼容）
const t0 = Date.now()
try {
  const s = await syncOnce()
  console.log(`[domain-sync] 完成: 新增 ${s.added} / 更新 ${s.updated} / 跳过 ${s.skipped} / 失败 ${s.failed}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  console.log('[domain-sync] pending 行将由服务进程摄取 worker 自动消费')
} catch (e) {
  console.error(`[domain-sync] 失败: ${e.message}`)
  process.exit(1)
}
process.exit(0)
