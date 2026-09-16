// ============================================================================
// 密码学辅助：scrypt 哈希/校验 + AUTH_USERS 预置用户播种
// ----------------------------------------------------------------------------
// 密码安全策略：.env 里的明文只存在于配置层；入库一律 scrypt(salt) 哈希，
// 校验用 timingSafeEqual 防时序侧信道。老密码哈希格式变化时可重播种（幂等）。
// ============================================================================

import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import { upsertUser, getUserByName, backfillDocsToUser } from './store/pg.js'

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
