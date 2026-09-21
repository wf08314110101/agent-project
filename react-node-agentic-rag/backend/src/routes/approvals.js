// ==========================================================================
// M20 审批路由（HITL 后半段）：确认执行 / 拒绝 / 查询
// confirm → executeWrite()（ingestOne 共享管线）→ 结果回填 approvals.result → 前端触发续答
// 审计：decided_at + result 落 approvals 行；执行侧 trace 由 executeWrite 的 span 承担
// ==========================================================================

import { executeWrite } from '../agent/write.js'
import { listApprovalsByUser, getApproval, setApprovalStatus, expireStaleApprovals } from '../store/pg.js'
import { config } from '../config.js'

export default async function (app) {
  // 定时把超时未决审批置为 expired（approve/reject 侧各自幂等校验，双保险）
  setInterval(async () => {
    try {
      const n = await expireStaleApprovals()
      if (n.length) app.log.info(`[approval] ${n.length} 张审批单超时过期`)
    } catch { /* 下轮重试 */ }
  }, 60_000).unref?.()

  // GET /api/approvals — 本人的审批单（最新在前）
  app.get('/api/approvals', async (req) => listApprovalsByUser(req.user.sub))

  // POST /api/approvals/:id/confirm — 批准并执行写操作
  app.post('/api/approvals/:id/confirm', async (req, reply) => {
    const ap = await getApproval(req.params.id)
    if (!ap || ap.user_id !== req.user.sub) return reply.code(404).send({ error: '审批单不存在' })
    if (ap.status !== 'pending') return reply.code(409).send({ error: `审批单已处理（${ap.status}）` })
    if (new Date(ap.expires_at) < new Date()) {
      await setApprovalStatus('expired', null, '审批超时', ap.id)
      return reply.code(410).send({ error: '审批已超时' })
    }

    const { result, error } = await executeWrite(ap.id, req.user, app.log)
    if (error) return reply.code(422).send({ error })
    return { ok: true, result }
  })

  // POST /api/approvals/:id/reject — 拒绝（暂存文件由 TTL 清扫回收，可重新上传发起新审批）
  app.post('/api/approvals/:id/reject', async (req, reply) => {
    const ap = await getApproval(req.params.id)
    if (!ap || ap.user_id !== req.user.sub) return reply.code(404).send({ error: '审批单不存在' })
    if (ap.status !== 'pending') return reply.code(409).send({ error: `审批单已处理（${ap.status}）` })
    await setApprovalStatus('rejected', null, null, ap.id)
    app.log.info(`[approval] ${ap.id} 被用户拒绝`)
    return { ok: true, status: 'rejected' }
  })
}
