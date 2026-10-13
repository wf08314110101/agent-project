// ============================================================================
// M23 用户长期记忆自助管理路由：查看 / 删除（隐私合规底线）
// ----------------------------------------------------------------------------
// 分层记忆 L2 的治理面：用户有权看到系统记住了自己什么、并要求遗忘。
// 隔离规则与会话路由一致：归属校验单点判定，别人的记忆 404 不泄露存在性。
// 删除 = pg 软删（status=deleted，留痕保审计）+ Qdrant 向量同步删除；
// 向量删除失败不阻断（召回以 pg status 为事实源，残留点位不会再被召回）。
// ============================================================================

import { listMemoriesByUser, getMemoryRow, softDeleteMemory } from '../store/pg.js'
import { deleteMemoryPoint } from '../rag/qdrant.js'

export default async function (app) {
  // 记忆列表（当前用户，不含已删除；按最近更新倒序）
  app.get('/api/memories', async (req) => listMemoriesByUser(req.user.sub))

  // 删除单条记忆
  app.delete('/api/memories/:id', async (req, reply) => {
    const row = await getMemoryRow(req.params.id)
    if (!row || row.user_id !== req.user.sub) return reply.code(404).send({ error: '记忆不存在' })
    await softDeleteMemory(row.id)
    await deleteMemoryPoint(row.id).catch(() => { }) // 向量残留无害，召回以 pg 为准
    return { ok: true }
  })
}
