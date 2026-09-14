import { listSessions, getSession, deleteSession, deleteSessionMsgs, listMsgs } from '../store/sqlite.js'

export default async function (app) {
  app.get('/api/sessions', () => listSessions.all())

  app.get('/api/sessions/:id/messages', (req, reply) => {
    const s = getSession.get(req.params.id)
    if (!s) return reply.code(404).send({ error: '会话不存在' })
    return listMsgs.all(s.id).map((m) => ({
      seq: m.seq,
      role: m.role,
      content: m.content,
      meta: m.meta ? JSON.parse(m.meta) : null,
      created_at: m.created_at,
    }))
  })

  app.delete('/api/sessions/:id', (req) => {
    deleteSessionMsgs.run(req.params.id) // 先删消息，再删会话
    deleteSession.run(req.params.id)
    return { ok: true }
  })
}
