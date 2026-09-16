// ============================================================================
// 会话路由：会话列表 / 消息回放 / 会话删除（M5 起按用户隔离）
// ----------------------------------------------------------------------------
// 配合 chat 路由的持久化：assistant 消息 meta 列存了 {sources, steps, usage,
// stopReason}，回放时原样返回给前端（Postgres JSONB 读出即对象），实现
// "刷新页面可完整还原推理过程"。
// 隔离规则：所有查询/删除前先校验会话归属（user_id === req.user.sub），
// 不存在的会话与别人的会话统一返回 404，不泄露资源存在性。
// ============================================================================

import { listSessionsByUser, getSession, deleteSession, deleteSessionMsgs, listMsgs } from '../store/pg.js'

export default async function (app) {
  // 会话列表（倒序），仅当前用户的，含标题与创建时间
  app.get('/api/sessions', async (req) => listSessionsByUser(req.user.sub))

  // 会话消息回放：meta（JSONB，读出即对象）随消息返回
  app.get('/api/sessions/:id/messages', async (req, reply) => {
    const s = await getSession(req.params.id)
    if (!s || s.user_id !== req.user.sub) return reply.code(404).send({ error: '会话不存在' })
    const rows = await listMsgs(s.id)
    return rows.map((m) => ({
      seq: m.seq,                    // 全局自增序号，前端可据此排序
      role: m.role,                  // user | assistant
      content: m.content,            // 消息正文
      meta: m.meta ?? null,          // {sources, steps, usage, stopReason}
      created_at: m.created_at,
    }))
  })

  // 删除会话：先删消息再删会话本身（避免残留孤儿消息）
  app.delete('/api/sessions/:id', async (req, reply) => {
    const s = await getSession(req.params.id)
    if (!s || s.user_id !== req.user.sub) return reply.code(404).send({ error: '会话不存在' })
    await deleteSessionMsgs(s.id) // 先删消息，再删会话
    await deleteSession(s.id)
    return { ok: true }
  })
}
