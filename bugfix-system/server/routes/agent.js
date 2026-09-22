import { createReadStream, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { one, many, q } from '../db/pg.js';
import { cfg } from '../config.js';

const MAX_DIFF_BYTES = 200 * 1024;
const MAX_TRACE_BYTES = 64 * 1024;

function auth(req, reply) {
  const got = req.headers['x-agent-token'] || '';
  const want = cfg.agentToken;
  const ok = want && got.length === want.length &&
    timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) reply.code(401).send({ error: 'unauthorized' });
  return ok;
}

const cap = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '\n...[truncated]' : s);

export default async function (app) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/agent/') && !auth(req, reply)) return reply;
  });

  // 领单：取最老的 queued 批次，上租约锁
  app.post('/agent/claim', async (_req, reply) => {
    const batch = await one(`
      UPDATE batches SET status='running', attempts=attempts+1,
        locked_until = now() + make_interval(secs => $1::int), worktree_path=NULL
      WHERE id = (SELECT id FROM batches WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [cfg.leaseSec]);
    if (!batch) return reply.send({ claim: null });
    await q(`UPDATE bugs SET status='fixing', updated_at=now()
             WHERE id IN (SELECT bug_id FROM batch_bugs WHERE batch_id=$1)`, [batch.id]);
    const project = await one(`SELECT * FROM projects WHERE id=$1`, [batch.project_id]);
    const bugs = await many(`
      SELECT b.*, json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mime', a.mime, 'size', a.size)) AS attachments
      FROM batch_bugs bb JOIN bugs b ON b.id=bb.bug_id
      LEFT JOIN bug_attachments a ON a.bug_id=b.id
      WHERE bb.batch_id=$1 GROUP BY b.id ORDER BY b.id`, [batch.id]);
    console.log(`[agent-api] 批次 #${batch.id} 已领取 (${bugs.length} 个 BUG)`);
    return reply.send({ claim: { batch, project, bugs } });
  });

  // 下载截图附件
  app.get('/agent/attachments/:id', async (req, reply) => {
    const att = await one(`SELECT * FROM bug_attachments WHERE id=$1`, [req.params.id]);
    if (!att || !existsSync(att.path)) return reply.code(404).send({ error: 'not found' });
    return reply.type(att.mime).send(createReadStream(att.path));
  });

  // 心跳续租
  app.post('/agent/heartbeat', async (req, reply) => {
    const { batch_id } = req.body || {};
    const row = await one(
      `UPDATE batches SET locked_until = now() + make_interval(secs => $2::int)
       WHERE id=$1 AND status='running' RETURNING id`, [batch_id, cfg.leaseSec]);
    return reply.send({ ok: !!row });
  });

  // 上报修复结果
  app.post('/agent/report', async (req, reply) => {
    const { batch_id, ok, error = null, test_output = null, fixes = [], traces = [], branch = null } = req.body || {};
    const batch = await one(`SELECT * FROM batches WHERE id=$1`, [batch_id]);
    if (!batch) return reply.code(404).send({ error: 'batch not found' });
    if (!['running', 'queued'].includes(batch.status)) {
      return reply.code(409).send({ error: `批次状态 ${batch.status}，无法上报（租约可能已被回收）` });
    }
    if (branch && branch !== batch.branch) {
      await q(`UPDATE batches SET branch=$2 WHERE id=$1`, [batch.id, branch]); // 重试换新分支名
    }
    for (const t of traces) {
      await q(`INSERT INTO traces (batch_id, step, payload) VALUES ($1,$2,$3)`,
        [batch.id, String(t.step || '').slice(0, 100), t.payload ?? null]);
    }
    if (ok && fixes.length > 0) {
      for (const f of fixes) {
        await q(
          `INSERT INTO fixes (batch_id, bug_id, commit_sha, commit_message, diff, fixed_files, root_cause, summary, verify)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [batch.id, f.bug_id, f.commit_sha, f.commit_message, cap(f.diff, MAX_DIFF_BYTES),
           JSON.stringify(f.fixed_files || []), cap(f.root_cause, 4000), cap(f.summary, 4000), cap(f.verify, 8000)]);
        await q(`UPDATE bugs SET status='await_confirm', fail_reason=NULL, updated_at=now() WHERE id=$1`, [f.bug_id]);
      }
      await q(`UPDATE batches SET status='awaiting_review', locked_until=NULL,
               error=NULL, report=jsonb_set(COALESCE(report,'{}'::jsonb), '{test_output}', to_jsonb($2::text)) WHERE id=$1`,
        [batch.id, cap(test_output, 32 * 1024) || '']);
      console.log(`[agent-api] 批次 #${batch.id} 修复完成 → 待审查 (${fixes.length} 个 fix)`);
    } else {
      // ok 但 0 修复，或执行面报错 → 批次失败（没有可审查的内容）
      const msg = ok ? '未产出修复' : error;
      await q(`UPDATE batches SET status='failed', locked_until=NULL, error=$2, decided_at=now() WHERE id=$1`,
        [batch.id, cap(msg, 4000)]);
      await q(`UPDATE bugs SET status='failed', fail_reason=$2, updated_at=now()
               WHERE id IN (SELECT bug_id FROM batch_bugs WHERE batch_id=$1) AND status IN ('fixing','await_confirm')`,
        [batch.id, cap(msg, 500)]);
      console.log(`[agent-api] 批次 #${batch.id} 修复失败: ${msg}`);
    }
    return reply.send({ ok: true });
  });

  // 领取待执行的合并指令
  app.get('/agent/commands', async (_req, reply) => {
    const rows = await many(`
      SELECT bt.id AS batch_id, bt.branch, p.rel_path
      FROM batches bt JOIN projects p ON p.id=bt.project_id
      WHERE bt.status='approved' ORDER BY bt.id`);
    return reply.send({ commands: rows.map((r) => ({ action: 'merge', ...r })) });
  });

  // 上报合并执行结果
  app.post('/agent/report-merge', async (req, reply) => {
    const { batch_id, success, merged_commit = null, error = null, worktree_path = null } = req.body || {};
    const batch = await one(`SELECT * FROM batches WHERE id=$1`, [batch_id]);
    if (!batch) return reply.code(404).send({ error: 'batch not found' });
    if (success) {
      await q(`UPDATE batches SET status='merged', decided_at=now(), worktree_path=COALESCE($2, worktree_path),
               report=jsonb_set(COALESCE(report,'{}'::jsonb), '{merged_commit}', to_jsonb($3::text)) WHERE id=$1`,
        [batch.id, worktree_path, merged_commit || '']);
      await q(`UPDATE bugs SET status='confirmed', updated_at=now()
               WHERE id IN (SELECT bug_id FROM batch_bugs WHERE batch_id=$1)`, [batch.id]);
      console.log(`[agent-api] 批次 #${batch.id} 已合并 → BUG 关单`);
    } else {
      await q(`UPDATE batches SET status='awaiting_review', error=$2 WHERE id=$1`, [batch.id, cap(error, 4000)]);
      console.log(`[agent-api] 批次 #${batch.id} 合并失败: ${error}`);
    }
    return reply.send({ ok: true });
  });
}
