import { createWriteStream, createReadStream, statSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { many, one, q } from '../db/pg.js';
import { cfg } from '../config.js';

const BUG_STATUSES = ['submitted', 'queued', 'fixing', 'await_confirm', 'confirmed', 'failed', 'rejected'];

export default async function (app) {
  app.get('/api/bugs', async (req) => {
    const { project_id, status } = req.query;
    const conds = [], params = [];
    if (project_id) { params.push(project_id); conds.push(`b.project_id=$${params.length}`); }
    if (status) { params.push(status); conds.push(`b.status=$${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return many(`
      SELECT b.*, p.name AS project_name,
             (SELECT COUNT(*) FROM bug_attachments a WHERE a.bug_id=b.id) AS attachment_count,
             (SELECT f.commit_sha FROM fixes f WHERE f.bug_id=b.id ORDER BY f.id DESC LIMIT 1) AS commit_sha
      FROM bugs b JOIN projects p ON p.id=b.project_id
      ${where} ORDER BY b.id DESC LIMIT 200`, params);
  });

  app.get('/api/bugs/:id', async (req, reply) => {
    const bug = await one(`
      SELECT b.*, p.name AS project_name, p.rel_path, p.test_cmd
      FROM bugs b JOIN projects p ON p.id=b.project_id WHERE b.id=$1`, [req.params.id]);
    if (!bug) return reply.code(404).send({ error: 'not found' });
    bug.attachments = await many(`SELECT id, filename, mime, size FROM bug_attachments WHERE bug_id=$1`, [bug.id]);
    bug.fixes = await many(`SELECT * FROM fixes WHERE bug_id=$1 ORDER BY id`, [bug.id]);
    bug.batches = await many(`
      SELECT bt.* FROM batches bt JOIN batch_bugs bb ON bb.batch_id=bt.id
      WHERE bb.bug_id=$1 ORDER BY bt.id DESC`, [bug.id]);
    return bug;
  });

  // 提交 BUG：multipart（文字字段 + 截图多张）或 JSON
  app.post('/api/bugs', async (req, reply) => {
    const fields = {};
    const files = [];
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (!/^image\//.test(part.mimetype)) continue;
          files.push(part);
        } else {
          fields[part.fieldname] = (part.value ?? '').toString().trim();
        }
      }
    } else {
      Object.assign(fields, req.body || {});
    }
    const { title, description = '', project_id, severity = 'P2', related_group = null } = fields;
    if (!title || !project_id) return reply.code(400).send({ error: 'title 和 project_id 必填' });
    const project = await one(`SELECT * FROM projects WHERE id=$1 AND enabled`, [project_id]);
    if (!project) return reply.code(400).send({ error: '项目不存在或未启用' });
    if (!BUG_STATUSES.includes(severity) && !/^P[1-4]$/.test(severity)) {
      return reply.code(400).send({ error: 'severity 取值 P1-P4' });
    }
    if (files.length > 10) return reply.code(400).send({ error: '截图最多 10 张' });

    const bug = await one(
      `INSERT INTO bugs (project_id, title, description, severity, related_group)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [project_id, title, description, severity, related_group || null]);

    await mkdir(cfg.attachmentDir, { recursive: true });
    for (const f of files) {
      const ext = path.extname(f.filename || '') || '.png';
      const stored = path.join(cfg.attachmentDir, `${randomUUID()}${ext}`);
      await pipeline(f.file, createWriteStream(stored));
      const size = statSync(stored).size;
      await q(
        `INSERT INTO bug_attachments (bug_id, filename, path, mime, size) VALUES ($1,$2,$3,$4,$5)`,
        [bug.id, f.filename || ext, stored, f.mimetype, size]);
    }
    reply.code(201);
    return { ...bug, attachment_count: files.length };
  });

  // 前端截图预览
  app.get('/api/attachments/:id', async (req, reply) => {
    const att = await one(`SELECT * FROM bug_attachments WHERE id=$1`, [req.params.id]);
    if (!att || !existsSync(att.path)) return reply.code(404).send({ error: 'not found' });
    return reply.type(att.mime).send(createReadStream(att.path));
  });
}
