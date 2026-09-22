import { many, one, q } from '../db/pg.js';

export default async function (app) {
  app.get('/api/projects', async () => {
    const rows = await many(`
      SELECT p.*, COUNT(b.id) FILTER (WHERE b.status NOT IN ('confirmed','rejected')) AS open_bugs
      FROM projects p LEFT JOIN bugs b ON b.project_id = p.id
      GROUP BY p.id ORDER BY p.id`);
    return rows;
  });

  app.post('/api/projects', async (req, reply) => {
    const { name, rel_path, test_cmd = null, install_cmd = null } = req.body || {};
    if (!name || !rel_path) return reply.code(400).send({ error: 'name 和 rel_path 必填' });
    try {
      return await one(
        `INSERT INTO projects (name, rel_path, test_cmd, install_cmd) VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, rel_path, test_cmd, install_cmd]);
    } catch (e) {
      return reply.code(409).send({ error: '项目名已存在' });
    }
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { test_cmd, install_cmd, enabled } = req.body || {};
    const row = await one(
      `UPDATE projects SET
         test_cmd = COALESCE($2, test_cmd),
         install_cmd = COALESCE($3, install_cmd),
         enabled = COALESCE($4, enabled)
       WHERE id=$1 RETURNING *`,
      [req.params.id, test_cmd, install_cmd, enabled]);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });
}
