import { one, q } from '../db/pg.js';

// 人工决策：批准(下发合并指令) / 拒绝 / 标记已手动合并
export default async function (app) {
  app.post('/api/batches/:id/approve', async (req, reply) => {
    const batch = await one(`SELECT * FROM batches WHERE id=$1`, [req.params.id]);
    if (!batch) return reply.code(404).send({ error: 'not found' });
    if (batch.status !== 'awaiting_review') {
      return reply.code(409).send({ error: `当前状态 ${batch.status} 不可批准` });
    }
    // 回归门禁：测试未通过不允许进入合并（可走「标记已手动合并」人工兜底）
    if (batch.report?.test_output?.startsWith('FAIL')) {
      return reply.code(409).send({ error: '回归测试未通过，禁止批准合并' });
    }
    return one(`UPDATE batches SET status='approved', error=NULL WHERE id=$1 RETURNING *`, [batch.id]);
  });

  app.post('/api/batches/:id/reject', async (req, reply) => {
    const batch = await one(`SELECT * FROM batches WHERE id=$1`, [req.params.id]);
    if (!batch) return reply.code(404).send({ error: 'not found' });
    if (!['awaiting_review', 'approved'].includes(batch.status)) {
      return reply.code(409).send({ error: `当前状态 ${batch.status} 不可拒绝` });
    }
    const reason = (req.body?.reason || '').trim();
    await q(`UPDATE batches SET status='rejected', decided_at=now(),
             error=CASE WHEN $2<>'' THEN $2 ELSE NULL END WHERE id=$1`, [batch.id, reason]);
    await q(`UPDATE bugs SET status='rejected', fail_reason=NULLIF($2,''), updated_at=now()
             WHERE id IN (SELECT bug_id FROM batch_bugs WHERE batch_id=$1)`, [batch.id, reason]);
    return { ok: true };
  });

  // 合并冲突后人工在本地解决并自行 merge，然后点击此按钮关单
  app.post('/api/batches/:id/mark-merged', async (req, reply) => {
    const batch = await one(`SELECT * FROM batches WHERE id=$1`, [req.params.id]);
    if (!batch) return reply.code(404).send({ error: 'not found' });
    if (!['awaiting_review', 'approved'].includes(batch.status)) {
      return reply.code(409).send({ error: `当前状态 ${batch.status} 不可标记合并` });
    }
    await q(`UPDATE batches SET status='merged', decided_at=now(),
             report=jsonb_set(COALESCE(report,'{}'::jsonb), '{merged_by}', '"manual"') WHERE id=$1`, [batch.id]);
    await q(`UPDATE bugs SET status='confirmed', updated_at=now()
             WHERE id IN (SELECT bug_id FROM batch_bugs WHERE batch_id=$1)`, [batch.id]);
    return { ok: true };
  });
}
