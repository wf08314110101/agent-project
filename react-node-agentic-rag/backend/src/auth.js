// ============================================================================
// 密码学辅助：scrypt 哈希/校验 + AUTH_USERS 预置用户播种
// ----------------------------------------------------------------------------
// 密码安全策略：.env 里的明文只存在于配置层；入库一律 scrypt(salt) 哈希，
// 校验用 timingSafeEqual 防时序侧信道。老密码哈希格式变化时可重播种（幂等）。
// ============================================================================

import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { config } from './config.js'
import {
  upsertUser,
  getUserByName,
  getUserById,
  backfillDocsToUser,
  bumpUserTokenVer,
} from './store/pg.js'

/** 生成 scrypt 口令哈希：`salt:hash`（hex），64 字节派生长度 */
export function hashPassword(pwd) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(pwd, salt, 64).toString('hex')}`
}

/** 校验口令：常数时间比较，防时序攻击 */
export function verifyPassword(pwd, stored) {
  const [salt, hex] = String(stored).split(':')
  if (!salt || !hex) return false
  const calc = scryptSync(pwd, salt, 64)
  const real = Buffer.from(hex, 'hex')
  return real.length === calc.length && timingSafeEqual(calc, real)
}

/** 登录校验：返回用户行或 null（用户不存在与密码错误统一返回 null，避免枚举用户名） */
export async function checkLogin(username, password) {
  const u = await getUserByName(username)
  return u && verifyPassword(password, u.pass_hash) ? u : null
}

/**
 * 启动播种：AUTH_USERS 里的用户逐个入库（幂等）。
 * 密码只写一次不覆盖；role/dept 每次启动按 env 刷新（改角色/部门改 env 即可）。
 */
export async function seedUsers(log = console) {
  if (!config.auth.users.length) {
    log.warn?.('[auth] AUTH_USERS 未配置：无人能登录。格式 AUTH_USERS=用户名:密码[:角色:部门],…')
    return
  }
  let n = 0
  for (const { username, password, role, dept } of config.auth.users) {
    const before = await getUserByName(username)
    await upsertUser(randomUUID(), username, hashPassword(password), role, dept)
    if (!before) n++
    // M14：启动刷新导致 role/dept 变化时 bump ver，旧 token 携带旧权限立即失效（env 为准语义保持）
    else if (before.role !== role || before.dept !== dept) await bumpTokenVer(before.id)
  }
  // 历史文档回填：M5 前入库的文档（user_id=''）划给首个预置用户，否则无人能管理/删除
  const first = config.auth.users[0]
  const owner = await getUserByName(first.username)
  if (owner) {
    const changes = await backfillDocsToUser(owner.id)
    if (changes) log.info?.(`[auth] 历史文档归属回填 → ${first.username}（${changes} 个）`)
  }
  log.info?.(`[auth] 预置用户就绪（新增 ${n}/${config.auth.users.length}）`)
}

// ============================================================================
// M14 无状态鉴权：token_ver 即刻失效 + refresh token 旋转
// ----------------------------------------------------------------------------
// access JWT 短效（默认 15m），payload 携带 role/dept/ver → authenticate 无需查库；
// 权限变更（admin PATCH / 启动播种 role 变化）bump token_ver，旧 token 的 ver 对不上立即 401。
// ver 读取走两级缓存：Redis（多实例共享，TTL 300s）→ 进程内存（单实例，TTL 60s）→ pg 兜底回填。
// refresh 单活模型：每用户仅一个有效 refresh（sha256 落库），登录/刷新覆盖、登出置空。
// ============================================================================

let verRedis = null // server.js 注入 ioredis 实例（REDIS_URL 未配则为 null）
const memVer = new Map() // sub → { v, exp }（进程内缓存，TTL 60s）
const VER_REDIS_TTL = 300
const VER_MEM_TTL = 60_000

/** server.js 启动时注入共享 Redis 客户端（可 null） */
export function initAuthCache(redis = null) {
  verRedis = redis
}

/** 当前用户 token_ver：两级缓存 → pg */
export async function currentTokenVer(sub) {
  if (verRedis) {
    const v = await verRedis.get(`user:ver:${sub}`).catch(() => null)
    if (v !== null) return Number(v)
  }
  const m = memVer.get(sub)
  if (m && m.exp > Date.now()) return m.v
  const u = await getUserById(sub)
  const v = u?.token_ver ?? 0
  memVer.set(sub, { v, exp: Date.now() + VER_MEM_TTL })
  if (verRedis) await verRedis.set(`user:ver:${sub}`, String(v), 'EX', VER_REDIS_TTL).catch(() => {})
  return v
}

/** 权限变更后调用：pg ver+1 + 双层缓存同步刷新（本实例立即生效，其他实例 ≤300s 或下次 miss 生效） */
export async function bumpTokenVer(sub) {
  const v = await bumpUserTokenVer(sub)
  memVer.set(sub, { v, exp: Date.now() + VER_MEM_TTL })
  if (verRedis) await verRedis.set(`user:ver:${sub}`, String(v), 'EX', VER_REDIS_TTL).catch(() => {})
  return v
}

/** refresh token：明文只返回给客户端一次，库中仅存 sha256 */
export function newRefreshToken() {
  const plain = randomBytes(48).toString('hex')
  return { plain, hash: sha256(plain) }
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex')
