// ============================================================================
// 鉴权路由：POST /api/auth/login（M5 方案 C：预置用户 + JWT，无开放注册）
// ----------------------------------------------------------------------------
// 流程：用户名+密码 → scrypt 校验 → 签发 JWT（24h，payload: sub=userId, username）
// 前端把 token 放 localStorage，后续请求带 Authorization: Bearer <token>；
// 受保护路由统一走 server.js 里注册的 authenticate 装饰器校验。
// ============================================================================

import { checkLogin } from '../auth.js'

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

      const token = app.jwt.sign({ sub: u.id, username: u.username }, { expiresIn: '24h' })
      // M10：返回 role/dept 供前端展示（权限判定以后端为准，前端仅用其显隐 UI）
      return { token, username: u.username, role: u.role || 'member', dept: u.dept || '', expiresIn: 86400 }
    }
  )
}
