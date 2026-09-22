import { many, one } from '../db/pg.js';

export default async function (app) {
  app.get('/api/batches', async (req) => {
    const { status } = req.query;
    const where = status ? 'WHERE bt.status=$1' : '';
    return many(`
      SELECT bt.*, p.name AS project_name,
             (SELECT json_agg(json_build_object('id', b.id, 'title', b.title, 'status', b.status))
              FROM batch_bugs bb JOIN bugs b ON b.id=bb.bug_id WHERE bb.batch_id=bt.id) AS bugs
      FROM batches bt JOIN projects p ON p.id=bt.project_id
      ${where} ORDER BY bt.id DESC LIMIT 100`, status ? [status] : []);
  });

  app.get('/api/batches/:id', async (req, reply) => {
    const batch = await one(`
      SELECT bt.*, p.name AS project_name, p.rel_path, p.test_cmd
      FROM batches bt JOIN projects p ON p.id=bt.project_id WHERE bt.id=$1`, [req.params.id]);
    if (!batch) return reply.code(404).send({ error: 'not found' });
    batch.bugs = await many(`
      SELECT b.* FROM batch_bugs bb JOIN bugs b ON b.id=bb.bug_id WHERE bb.batch_id=$1 ORDER BY b.id`, [batch.id]);
    batch.fixes = await many(`SELECT * FROM fixes WHERE batch_id=$1 ORDER BY id`, [batch.id]);
    batch.traces = await many(`SELECT id, step, payload, created_at FROM traces WHERE batch_id=$1 ORDER BY id`, [batch.id]);
    return batch;
  });
}
