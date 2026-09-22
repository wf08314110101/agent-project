import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { ensureSchema } from './db/schema.js';
import { startScheduler } from './queue/scheduler.js';
import projects from './routes/projects.js';
import bugs from './routes/bugs.js';
import batches from './routes/batches.js';
import actions from './routes/actions.js';
import agentRoutes from './routes/agent.js';

const root = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 10 } });

await app.register(projects);
await app.register(bugs);
await app.register(batches);
await app.register(actions);
await app.register(agentRoutes);

// 前端产物（frontend/dist 存在时托管）
const dist = path.join(root, '../frontend/dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/agent/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

await ensureSchema();
const timer = startScheduler();
await app.listen({ port: cfg.port, host: '0.0.0.0' });
console.log(`[server] 控制面已启动 http://localhost:${cfg.port}（调度器每 10s 归批/回收租约）`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(timer); app.close().then(() => process.exit(0)); });
}
