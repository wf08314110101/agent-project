// ============================================================================
// 摄取事件总线（M12 多实例）：Redis pub/sub 广播 + 本地 ingestBus 兜底
// ----------------------------------------------------------------------------
// 单实例/未配 REDIS_URL：publishDocEvent 直投本地 ingestBus（零依赖内存模式）。
// 多实例：worker 事件 → Redis channel `rag:doc-events`；每个实例订阅后转发到
// 本地 ingestBus → 各自的 SSE 连接收到广播（SSE 路由零改动）。
// 发布失败降级为本地直投（进度推送尽力而为，不阻塞摄取流水线）。
// ============================================================================

import { EventEmitter } from 'node:events'
import Redis from 'ioredis'
import { config } from '../config.js'

// 本地事件总线：SSE 端点订阅端；事件形状 { id, filename, user_id, status, progress, chunks?, error? }
export const ingestBus = new EventEmitter()
ingestBus.setMaxListeners(50) // SSE 订阅者随在线用户数增长，放宽默认 10 的告警阈值

const CHANNEL = 'rag:doc-events'

let pub = null
let sub = null

if (config.redis.url) {
  pub = new Redis(config.redis.url, { maxRetriesPerRequest: 2 })
  sub = pub.duplicate() // 订阅必须独占连接
  sub.subscribe(CHANNEL).catch((e) => console.error(`[bus] redis 订阅失败: ${e.message}`))
  sub.on('message', (_ch, raw) => {
    try {
      ingestBus.emit('doc', JSON.parse(raw))
    } catch { /* 坏消息直接丢弃 */ }
  })
  pub.on('error', (e) => console.error(`[bus] redis pub 错误: ${e.message}`))
  sub.on('error', (e) => console.error(`[bus] redis sub 错误: ${e.message}`))
}

/** 广播一条摄取进度事件（worker 唯一出口） */
export function publishDocEvent(event) {
  if (!pub) {
    ingestBus.emit('doc', event)
    return
  }
  pub.publish(CHANNEL, JSON.stringify(event)).catch(() => {
    ingestBus.emit('doc', event) // 发布失败降级本地（保底本实例 SSE 仍能看到进度）
  })
}

/** 优雅退出时关闭连接 */
export async function closeBus() {
  try { await sub?.quit() } catch { }
  try { await pub?.quit() } catch { }
}
