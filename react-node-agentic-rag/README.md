# Agentic RAG（React + Node.js）

生产形态的 Agentic RAG 参考实现：Agent 自主决策「何时检索、检索什么、结果不足时改写重检」，全链路可观测，坏用例可回归。

参考姊妹项目：`react-python-rag`（单路 RAG 基线）、`react-react-agent`（ReAct Agent 基线）。

## 架构

```
React 5174 ──SSE── Fastify 8788 ──┬── DeepSeek (LLM, 工具调用)
  ChatTab: 步骤时间线/来源卡片      │
  DocsTab: 上传+状态轮询            ├── LangGraph 主图: agent ⇄ tools (ReAct loop)
                                   │      └─ search_kb 子图: retrieve → grade → rewrite
                                   ├── Qdrant 6333 (向量) ←─ 本地嵌入 bge-small-zh (ONNX)
                                   └── SQLite (文档/会话/消息)
观测: Langfuse 云端 trace ｜ Phoenix OTel (PHOENIX_ENABLED=true)
```

## 功能

- **摄取队列**：上传即 202 入队，worker 后台解析→切块→嵌入，状态轮询；同内容 hash 去重；宕机自恢复
- **Agentic 检索**：多查询并发检索 + LLM 逐条相关性评估 + 材料不足自动改写重检（CRAG，有界 2 次）
- **工具调用**：search_knowledge / calculator / get_current_time；超 6 轮强制直答防死循环
- **会话**：多轮上下文、消息+步骤+来源持久化回放、会话增删
- **可观测**：Langfuse trace/generation/span + usage；Phoenix OTel（OpenInference 规范）
- **生产防线**：限流（全局 120/min、chat 20/min）、知识库为空降级直答、坏用例回归脚本、容器化部署

## 快速开始

```bash
# 1. 基础设施 + 依赖 + 前后端一键启动（Ctrl-C 全停）
cp backend/.env.example backend/.env   # 填 LLM_API_KEY（必填）
./start.sh

# 2. 生产形态（应用镜像入容器栈，访问 http://localhost:8080）
docker compose up -d backend frontend
```

浏览器打开 http://localhost:5174 （开发）或 http://localhost:8080 （容器栈）：
先在「文档管理」上传文档，再去「对话」提问。

## 配置（backend/.env）

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLM_API_KEY` | - | DeepSeek key，必填 |
| `LLM_MODEL` | deepseek-chat | 兼容 OpenAI 协议的模型名 |
| `LLM_BASE_URL` | api.deepseek.com/v1 | 任何 OpenAI 兼容端点 |
| `QDRANT_URL` / `QDRANT_COLLECTION` | localhost:6333 / agentic_docs | 向量库 |
| `EMBED_MODEL` / `EMBED_DIM` | Xenova/bge-small-zh-v1.5 / 512 | 本地嵌入 |
| `HF_ENDPOINT` | hf-mirror.com | 模型下载镜像（国内） |
| `RETRIEVE_MIN_SCORE` | 0.3 | 相似度阈值 |
| `AGENT_MAX_ITERATIONS` / `SEARCH_MAX_ATTEMPTS` | 6 / 2 | 主图轮数上限 / 检索重试上限 |
| `RATE_LIMIT_MAX` / `CHAT_RATE_LIMIT_MAX` | 120 / 20 | 每分钟限流 |
| `FALLBACK_DIRECT` | true | 知识库为空时通用知识直答（注明） |
| `LANGFUSE_*` | - | 配置即启用，不配为空壳 |
| `PHOENIX_ENABLED` / `PHOENIX_ENDPOINT` | false | OTel → Phoenix |

## API 与 SSE 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/documents` | multipart 上传，202 入队（`duplicated: true` 表示重复） |
| GET | `/api/documents` | 列表含 `status`(pending/processing/ready/failed) |
| DELETE | `/api/documents/:id` | 先删向量再删元数据；摄取中返回 409 |
| POST | `/api/chat` | `{question, topK, sessionId?}` → SSE |
| GET | `/api/sessions` · `/:id/messages` · DELETE | 会话管理 |
| GET | `/api/health` | 后端/Qdrant 健康与队列 |

`POST /api/chat` 事件流：`step`(action/observation，时间线) → `sources`(来源卡片) → `delta`(正文 token) → `usage`(轮次/token/耗时) → `done`(stopReason: normal/max_iter/abort/error) ｜ `error`。

## 回归测试

```bash
node scripts/regression.mjs          # 需先起服务；自举 fixture，5 类坏用例断言，失败退出码 1
BASE_URL=http://localhost:8080 node scripts/regression.mjs   # 打容器栈
```

## 已知坑（复盘）

1. `@qdrant/js-client-rest@1.19`：`upsert` 需 `{points:[...]}` 包装；`search()` 已删除改 `query()`（返回 `{points}`）
2. otel v2 移除 `Resource` 类，用 `resourceFromAttributes()`
3. node:24-slim 中 better-sqlite3 回退 node-gyp：Dockerfile 需 `python3 make g++`
4. nginx 反代 SSE 必须 `proxy_buffering off`，否则流式变一次性输出
5. SSE 误判断开：POST 体读完 `req.raw` 也会 close，需 `writableEnded` 守卫

## 目录

```
backend/src/  server·config·llm ｜ routes/(chat·documents·sessions·health)
              rag/(parser·chunker·embedder·qdrant·ingest) ｜ agent/(graph·search-graph·tools·prompts)
              store/sqlite ｜ obs/(langfuse·phoenix)
frontend/src/ App ｜ components/(ChatTab·DocsTab) ｜ api(SSE 解析)
scripts/      regression.mjs
docs/         功能演进时间线.md
```

设计取舍与演进方向详见 [docs/功能演进时间线.md](docs/功能演进时间线.md)。
