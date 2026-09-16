// ============================================================================
// 管理路由（M10，admin only）：用户列表 / 角色部门调整
// ----------------------------------------------------------------------------
// 用户创建仍走 AUTH_USERS 预置播种（无开放注册）；本路由用于运行期查看与调整，
// role/dept 每请求查库，改完即刻生效（下次重启会被 env 刷新，env 为准）。
// ============================================================================

import { listUsers, updateUserMeta } from '../store/pg.js'

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
    return (await listUsers()).find((u) => u.id === req.params.id)
  })
}
