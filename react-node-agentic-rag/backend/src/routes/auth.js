// ============================================================================
// 鉴权路由（M14）：POST /api/auth/login ｜ /refresh（旋转续期）｜ /logout（吊销）
// ----------------------------------------------------------------------------
// access JWT 短效（默认 15m），payload: sub/username/role/dept/ver —— authenticate
// 不再每请求查库；权限变更靠 token_ver 失效旧 token（见 auth.js M14 段）。
// refresh 单活模型：每用户一个有效 token（sha256 落库 users.refresh_hash），
// 登录/刷新都旋转出新 token 并覆盖旧值；被旋转的旧 refresh 天然失效（查找落空）。
// 前端：token 存 localStorage；401 时用 refreshToken 调 /refresh 续期并重放请求。
// ============================================================================

import { checkLogin, newRefreshToken, sha256 } from '../auth.js'
import { setRefreshToken, getUserByRefreshHash } from '../store/pg.js'
import { getTagWhitelist } from '../acl.js'
import { config } from '../config.js'

const REFRESH_MS = () => config.auth.refreshDays * 86400_000

/** 签发 access + 旋转 refresh：登录与刷新共用 */
async function issueTokens(app, u) {
  const token = app.jwt.sign(
    { sub: u.id, username: u.username, role: u.role || 'member', dept: u.dept || '', ver: u.token_ver ?? 0 },
    { expiresIn: config.auth.accessTtl }
  )
  const rt = newRefreshToken()
  await setRefreshToken(u.id, rt.hash, new Date(Date.now() + REFRESH_MS()))
  return { token, refreshToken: rt.plain }
}

const sessionBody = (u) => ({
  username: u.username,
  role: u.role || 'member',
  dept: u.dept || '',
  expiresIn: 900, // 提示前端 access 短效（与 JWT_ACCESS_TTL 保持一致时才准确，仅供 UI 参考）
})

export default async function (app) {
  app.post(
    '/api/auth/login',
    // 登录接口单独收紧限流：防暴力爆破（10 次/分钟/IP）
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password } = req.body ?? {}
      if (!username || !password) return reply.code(400).send({ error: 'username/password 必填' })

      const u = await checkLogin(String(username), String(password))
      if (!u) return reply.code(401).send({ error: '用户名或密码错误' })

      const { token, refreshToken } = await issueTokens(app, u)
      // M10：返回 role/dept 供前端展示（权限判定以后端为准，前端仅用其显隐 UI）
      return { token, refreshToken, ...sessionBody(u) }
    }
  )

  // 刷新：旋转出新的 access+refresh；旧 refresh 被覆盖后查找落空 → 天然一次性
  app.post(
    '/api/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { refreshToken } = req.body ?? {}
      if (!refreshToken) return reply.code(400).send({ error: 'refreshToken 必填' })
      const u = await getUserByRefreshHash(sha256(String(refreshToken)))
      if (!u) return reply.code(401).send({ error: '登录已过期，请重新登录' })
      if (u.refresh_exp && u.refresh_exp.getTime() < Date.now()) {
        await setRefreshToken(u.id, null, null)
        return reply.code(401).send({ error: '登录已过期，请重新登录' })
      }
      const { token, refreshToken: next } = await issueTokens(app, u)
      return { token, refreshToken: next, ...sessionBody(u) }
    }
  )

  // 登出：吊销当前 refresh（access 靠短效自然过期；需要立刻踢人走 admin 改权限 bump ver）
  app.post('/api/auth/logout', async (req, reply) => {
    const { refreshToken } = req.body ?? {}
    if (refreshToken) {
      const u = await getUserByRefreshHash(sha256(String(refreshToken)))
      if (u) await setRefreshToken(u.id, null, null)
    }
    return { ok: true }
  })

  // 前端元信息（公开）：当前生效标签词表——领域包注入后词表随模式变化，
  // 前端编辑器/筛选器必须动态取（硬编码会在领域模式下设置出被后端过滤成空的标签）
  app.get('/api/meta', async () => ({ tagWhitelist: getTagWhitelist() }))
}
