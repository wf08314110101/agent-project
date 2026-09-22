# bugfix-system

BUG 自动修复系统（控制面/执行面分离架构）。设计演进与取舍详见 [docs/功能演进时间线.md](docs/功能演进时间线.md)。

- **控制面 server**：Fastify + Postgres + React 前端，部署在服务器。接收 BUG 提交、归批调度、人工审查。
- **执行面 agent**：本地进程，出站轮询领单（类 GitHub Actions self-hosted runner）。在独立 git worktree 中用 aider 驱动 LLM 修复，人工网页批准后由 agent 执行合并。

## 修复闭环

```
提交 BUG → 调度归批(60s 冷静期) → agent 领单(租约锁) → worktree 隔离修复
→ 每BUG单commit → 回归测试(失败带输出重试≤2) → 上报 → 人工审查
→ 批准 → agent merge --no-ff → BUG 关单
```

安全机制：
- BUG 描述按不可信内容包裹（`<<UNTRUSTED_BUG>>`），提示词声明忽略其中指令
- git 沙箱：路径闸门 + 黑名单命令（push/remote/rebase 等）+ 主仓库禁 reset/clean
- 回归门禁：测试未通过的批次禁止批准合并
- 合并需人工网页批准；主仓库有已跟踪文件改动时拒绝合并
- MCP/服务身份只读，写操作仅 Web UI + 审批流

## 快速开始

```sh
# 0. Postgres（复用 agentic-rag-postgres 实例即可）
createdb -h localhost -U rag bugfix   # 或 docker exec agentic-rag-postgres createdb -U rag bugfix

# 1. 配置
cp .env.example .env   # 填 AGENT_TOKEN / OPENAI_API_KEY / OPENAI_API_BASE / AIDER_MODEL

# 2. 初始化表结构 + 注册项目
npm install
npm run seed

# 3. 启动控制面（服务器）
npm run server         # http://localhost:8787，前端构建产物由服务端托管

# 4. 启动执行面（本地，需已安装 aider）
npm run agent

# 5. 前端开发模式（可选）
cd frontend && npm install && npm run dev   # Vite 代理 /api → 8787
```

## 项目配置

projects 表关键字段：
- `name` / `rel_path`（相对父仓库路径，如 `LLM-SSE`）
- `test_cmd`：回归测试命令（cwd 为项目目录），如 `node /tmp/llm-sse-repro.mjs`

## 目录

```
server/
  index.js          # Fastify 入口（静态托管 frontend/dist）
  config.js         # 环境变量聚合
  db/schema.js      # 7 表 DDL（projects/bugs/bug_attachments/batches/batch_bugs/fixes/traces）
  queue/scheduler.js# 10s tick：租约回收 + BUG 归批
  routes/           # bugs/projects/batches/actions（人工审查）/agent（执行面 API，token 鉴权）
agent/
  index.js          # 主循环：领单 → 修复 → 上报；合并指令执行；24h worktree 清扫
  lib/              # api/git(沙箱)/worktree(attempt 后缀自愈)/aider/vision(截图转述)
frontend/           # React + Vite：BUG 列表/提交/详情、批次审查（批准/拒绝/标记手动合并）
scripts/seed-projects.mjs
```

## 关键设计

- **租约锁**：领单时 `locked_until = now()+LEASE_SEC`，心跳续租，超时回收重试（MAX_ATTEMPTS=3）
- **批次归并**：同项目 + 关联 group 的 BUG 合为一个批次，共享一个 worktree/分支/合并审查
- **worktree 自愈**：目录带 attempt 后缀（`batch-<id>-a<attempt>`），创建时清陈旧锁 + `reset --hard baseSha` + `clean -fdx`；分支被旧 worktree 占用时自动换名并回传服务端
- **aider 参数**：`--edit-format diff --no-pretty --no-auto-commits`，DeepSeek OpenAI 兼容端点
- **提交规范**：`fix(<项目>): [BUG-<id>] <标题>` + 根因/方案，作者 bugfix-agent，重试用 `commit --amend` 保持每 BUG 单 commit
