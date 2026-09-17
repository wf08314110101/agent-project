// ============================================================================
// 管理路由（M10，admin only）：用户列表 / 角色部门调整
// ----------------------------------------------------------------------------
// 用户创建仍走 AUTH_USERS 预置播种（无开放注册）；本路由用于运行期查看与调整。
// M14 无状态鉴权：role/dept 变更后 bump token_ver → 该用户旧 access token 立即 401，
// 前端 401 自续期流程会拿 refresh 换新 token（新 token 带新权限）。
// ============================================================================

import { listUsers, updateUserMeta } from '../store/pg.js'
import { bumpTokenVer } from '../auth.js'

const ROLES = ['member', 'admin']

export default async function (app) {
  // 组内守卫：非 admin 一律 403（不区分 404，避免暗示资源存在）
  app.addHook('preHandler', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: '需要管理员权限' })
  })

  app.get('/api/admin/users', async () => listUsers())

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { role, dept } = req.body ?? {}
    if (role !== undefined && !ROLES.includes(role)) return reply.code(400).send({ error: `role 必须是 ${ROLES.join('/')}` })
    if (dept !== undefined && typeof dept !== 'string') return reply.code(400).send({ error: 'dept 必须是字符串' })
    const cur = (await listUsers()).find((u) => u.id === req.params.id)
    if (!cur) return reply.code(404).send({ error: '用户不存在' })
    await updateUserMeta(role ?? cur.role, (dept ?? cur.dept).trim(), req.params.id)
    // 权限变更即刻失效该用户所有旧 access token（M14 ver 机制）
    if (role !== undefined || dept !== undefined) await bumpTokenVer(req.params.id)
    return (await listUsers()).find((u) => u.id === req.params.id)
  })
}
