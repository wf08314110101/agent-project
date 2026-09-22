import 'dotenv/config';

const int = (v, d) => (v ? parseInt(v, 10) : d);

export const cfg = {
  // 控制面
  port: int(process.env.PORT, 8787),
  databaseUrl: process.env.DATABASE_URL || 'postgres://rag:rag123@localhost:5432/bugfix',
  agentToken: process.env.AGENT_TOKEN || '',
  attachmentDir: process.env.ATTACHMENT_DIR || './data/attachments',
  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 10),
  leaseSec: int(process.env.LEASE_SEC, 900),
  maxAttempts: int(process.env.MAX_ATTEMPTS, 3),
  // 执行面
  serverUrl: process.env.SERVER_URL || 'http://localhost:8787',
  pollIntervalSec: int(process.env.POLL_INTERVAL_SEC, 30),
  bugTimeoutSec: int(process.env.BUG_TIMEOUT_SEC, 900),
  testTimeoutSec: int(process.env.TEST_TIMEOUT_SEC, 600),
  mainRepoRoot: process.env.MAIN_REPO_ROOT || process.cwd() + '/..',
  worktreeRoot: process.env.WORKTREE_ROOT || './worktrees',
  // LLM
  openaiApiBase: process.env.OPENAI_API_BASE || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  aiderModel: process.env.AIDER_MODEL || 'openai/deepseek-chat',
  aiderEditFormat: process.env.AIDER_EDIT_FORMAT || 'diff',
  visionModel: process.env.VISION_MODEL || '',
};

if (!cfg.agentToken) {
  console.warn('[config] AGENT_TOKEN 未设置，/agent/* 接口将拒绝所有请求');
}
