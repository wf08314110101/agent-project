// 注册父仓库下的子项目（幂等）——cwd 必须是 bugfix-system（dotenv 读取 .env）
import '../server/config.js';
import { ensureSchema } from '../server/db/schema.js';
import { q, pool } from '../server/db/pg.js';

await ensureSchema();

const PROJECTS = [
  { name: 'LLM-SSE', rel_path: 'LLM-SSE', test_cmd: null, install_cmd: null },
  { name: 'react-node-agentic-rag', rel_path: 'react-node-agentic-rag', test_cmd: 'npm test --prefix backend', install_cmd: null },
  { name: 'react-python-rag', rel_path: 'react-python-rag', test_cmd: null, install_cmd: null },
  { name: 'react-react-agent', rel_path: 'react-react-agent', test_cmd: 'npm run build', install_cmd: null },
];

for (const p of PROJECTS) {
  await q(
    `INSERT INTO projects (name, rel_path, test_cmd, install_cmd) VALUES ($1,$2,$3,$4)
     ON CONFLICT (name) DO UPDATE SET rel_path=EXCLUDED.rel_path, test_cmd=EXCLUDED.test_cmd, install_cmd=EXCLUDED.install_cmd`,
    [p.name, p.rel_path, p.test_cmd, p.install_cmd]);
  console.log(`project: ${p.name} (${p.rel_path})`);
}
await pool.end();
