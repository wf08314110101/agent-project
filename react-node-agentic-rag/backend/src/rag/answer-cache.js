// ============================================================================
// 回答缓存（ID6）：同问题 + 同可见资料（KB 纪元）+ 同 ACL 指纹 → 直接回放完整答案，
// 省掉检索/评估/LLM 全链路。纯优化层：任何故障静默降级为未命中。
// ----------------------------------------------------------------------------
// 键 = sha1(规范化问题 | topK | docId | ACL 指纹 | KB 纪元)
// KB 纪元（rag:kb:epoch:<collection>，M17 按集合分桶）：文档摄取 ready / 删除 / 密级授权
// 变更时 +1，该集合全部缓存天然失效，core 与领域语料更新互不干扰；
// 无需逐键清理，也避免"问题不变但资料变了仍回旧答案"的脏读。
// 存储：REDIS_URL 配置时走 Redis（多实例共享 + 多进程一致），否则进程内 Map（单实例零配置）。
// ============================================================================

import { createHash } from 'node:crypto'
import { config } from '../config.js'

let redis = null // 由 initAnswerCache 注入（server.js，与限流/auth 共用同一连接）
const mem = new Map() // 内存兜底存储 { v, exp }
const MEM_MAX = 200

let epochMem = new Map() // collection → 纪元（内存模式，M17 按集合分桶）
const ANS_PREFIX = 'rag:ans:'
const epochKey = (collection) => `rag:kb:epoch:${collection || 'core'}`

/** 注入共享 Redis 连接（server.js 启动时调用；不传 = 进程内存模式） */
export const initAnswerCache = (r) => { redis = r }

const ttlSec = () => config.answerCache.ttlSec

/** 当前 KB 纪元（资料版本号，按集合分桶——core 与领域语料更新互不清对方缓存） */
export async function kbEpoch(collection = '') {
  if (redis) {
    try { return Number((await redis.get(epochKey(collection))) ?? 0) || 0 } catch { return 0 }
  }
  return epochMem.get(collection) ?? 0
}

/** KB 纪元 +1：该集合资料变化（摄取 ready/删除/密级授权变更）后调用 */
export async function bumpKbEpoch(collection = '') {
  if (redis) {
    try { await redis.incr(epochKey(collection)) } catch { } // Redis 抖动不阻断主链路：最坏情况 = TTL 内旧答案
  } else {
    epochMem.set(collection, (epochMem.get(collection) ?? 0) + 1)
  }
}

/**
 * 缓存键：规范化问题 + 检索参数 + ACL 可见性指纹 + KB 纪元。
 * ACL 指纹：admin 共享一个桶；member 按 role|dept|授权文档集（排序后）区分——
 * 可见集合相同的用户共享缓存（答案不泄露，资料视野一致），不同则天然分键。
 */
export function answerCacheKey({ question, topK, docId, acl, epoch }) {
  const fp = !acl || acl.role === 'admin'
    ? 'admin'
    : `${acl.role}|${acl.dept ?? ''}|${[...(acl.grants ?? [])].sort().join(',')}`
  const norm = String(question ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha1').update([norm, topK, docId ?? '', fp, epoch].join('\n')).digest('hex')
}

/** 取缓存答案：{ answer, sources, usage, rounds } 或 null */
export async function getAnswer(key) {
  if (!ttlSec()) return null
  if (redis) {
    try {
      const raw = await redis.get(ANS_PREFIX + key)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }
  const e = mem.get(key)
  if (!e) return null
  if (e.exp < Date.now()) { mem.delete(key); return null }
  return e.v
}

/** 写缓存：值必须可 JSON 序列化；TTL 到期自动失效 */
export async function setAnswer(key, val) {
  if (!ttlSec()) return
  if (redis) {
    try { await redis.set(ANS_PREFIX + key, JSON.stringify(val), 'EX', ttlSec()) } catch { }
    return
  }
  if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value) // FIFO 淘汰
  mem.set(key, { v: val, exp: Date.now() + ttlSec() * 1000 })
}
