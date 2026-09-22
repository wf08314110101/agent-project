import { q, many, one } from '../db/pg.js';
import { cfg } from '../config.js';

const log = (...a) => console.log('[scheduler]', ...a);

// 回收租约过期的批次；重试超限则整批失败
async function reclaimExpired() {
  const expired = await many(
    `UPDATE batches SET status='queued', locked_until=NULL, attempts=attempts+1
     WHERE status='running' AND locked_until < now() RETURNING id, attempts`);
  for (const b of expired) {
    if (b.attempts >= cfg.maxAttempts) {
      await q(`UPDATE batches SET status='failed', error='重试超限（agent 租约超时）', decided_at=now() WHERE id=$1`, [b.id]);
      await q(`UPDATE bugs SET status='failed', fail_reason='批次重试超限', updated_at=now()
               WHERE id IN (SELECT bug_id FROM batch_bugs WHERE batch_id=$1)`, [b.id]);
      log(`批次 #${b.id} 重试超限 → failed`);
    } else {
      log(`批次 #${b.id} 租约过期 → 重新排队 (第 ${b.attempts} 次重试)`);
    }
  }
}

// 将 submitted 的 BUG 按 项目+关联组 归并成批次
async function groupBugs() {
  const submitted = await many(
    `SELECT b.*, p.enabled FROM bugs b JOIN projects p ON p.id=b.project_id
     WHERE b.status='submitted' AND p.enabled ORDER BY b.id`);
  const groups = new Map();
  for (const bug of submitted) {
    const key = `${bug.project_id}|${bug.related_group || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bug);
  }
  for (const bugs of groups.values()) {
    // 关联组未满员（同组 BUG 可能还在提交中）→ 延迟 60s 再归批
    const newest = Math.max(...bugs.map((b) => new Date(b.created_at).getTime()));
    if (Date.now() - newest < 60_000) continue;
    const batch = await one(
      `INSERT INTO batches (project_id, branch) VALUES ($1, $2) RETURNING id`,
      [bugs[0].project_id, `fix/batch-${Date.now().toString(36)}`]);
    for (const bug of bugs) {
      await q(`INSERT INTO batch_bugs (batch_id, bug_id) VALUES ($1,$2)`, [batch.id, bug.id]);
      await q(`UPDATE bugs SET status='queued', updated_at=now() WHERE id=$1`, [bug.id]);
    }
    log(`批次 #${batch.id} 创建，含 BUG: ${bugs.map((b) => `#${b.id}`).join(',')}`);
  }
}

export function startScheduler() {
  const tick = async () => {
    try {
      await reclaimExpired();
      await groupBugs();
    } catch (e) {
      console.error('[scheduler] tick 失败:', e.message);
    }
  };
  tick();
  return setInterval(tick, 10_000);
}
