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
观测: OTel 单管道双导出 → Langfuse 云端 ｜ Phoenix (PHOENIX_ENABLED=true)
```

## 功能

- **摄取队列**：上传即 202 入队，worker 后台解析→切块→嵌入（分批上报进度%），SSE 实时推送状态（断线自动回退轮询）；同内容 hash 去重；宕机自恢复
- **混合检索**：稠密（bge 语义）+ 稀疏（jieba 分词 BM25）双路 Qdrant 服务端 RRF 融合，关键词/专名查询不丢召回
- **Agentic 检索**：多查询并发检索 + LLM 逐条相关性评估（结果缓存）+ 材料不足自动改写重检（CRAG，有界 2 次）
- **工具调用**：search_knowledge / calculator / get_current_time；参数 schema 校验门、同参重复调用检测、同批多工具并行执行；超 6 轮强制直答防死循环
- **引用锚点**：检索块全局唯一编号，回答行内 [n] 可点击跳转对应来源卡片；指定文档问答（DocsTab「提问」→ 仅在该文档范围检索）
- **会话**：多轮上下文（超窗滚动摘要压缩，seq 断点零丢失）、消息+步骤+来源持久化回放、会话增删
- **思维链通道**：reasoning token 走独立 SSE 事件（deepseek-reasoner 等模型自动生效），前端折叠面板展示，不与正文混流
- **鉴权**：预置用户 + JWT 登录（scrypt 存储密码，24h 有效期），会话/文档按用户隔离；登录接口单独限流
- **可观测**：单一 OTel 管道双导出——Langfuse trace/span/usage + Phoenix OpenInference，一次埋点两平台同构
- **生产防线**：限流（全局 120/min、chat 20/min、login 10/min）、知识库为空降级直答、坏用例回归脚本、容器化部署（compose 健康检查依赖）、CI（回归 + 镜像构建）

## 快速开始

```bash
# 1. 基础设施 + 依赖 + 前后端一键启动（Ctrl-C 全停）
cp backend/.env.example backend/.env   # 填 LLM_API_KEY（必填）
./start.sh

# 2. 生产形态（应用镜像入容器栈，访问 http://localhost:8080）
docker compose up -d backend frontend
```

浏览器打开 http://localhost:5174 （开发）或 http://localhost:8080 （容器栈）：
默认账号 `demo / demo123`（`AUTH_USERS` 可改）登录，先在「文档管理」上传文档，再去「对话」提问。

## 配置（backend/.env）

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLM_API_KEY` | - | DeepSeek key，必填 |
| `LLM_MODEL` | deepseek-chat | 兼容 OpenAI 协议的模型名 |
| `LLM_BASE_URL` | api.deepseek.com/v1 | 任何 OpenAI 兼容端点 |
| `QDRANT_URL` / `QDRANT_COLLECTION` | localhost:6333 / agentic_docs | 向量库 |
| `EMBED_MODEL` / `EMBED_DIM` | Xenova/bge-small-zh-v1.5 / 512 | 本地嵌入 |
| `HF_ENDPOINT` | hf-mirror.com | 模型下载镜像（国内） |
| `RETRIEVE_MIN_SCORE` | 0.3 | 稠密路相似度阈值（RRF 融合分不再二次过滤） |
| `AGENT_MAX_ITERATIONS` / `SEARCH_MAX_ATTEMPTS` | 6 / 2 | 主图轮数上限 / 检索重试上限 |
| `WEB_SEARCH_PROVIDER` | bing | 网络兜底搜索源：bing（免 key）/ tavily（需 key）/ off（关闭） |
| `RETRIEVE_FUSION` / `RETRIEVE_PREFETCH_MUL` | rrf / 0 | 服务端融合算法（rrf / dbsf）/ 召回池倍率（M8 rerank 实验开关） |
| `TAVILY_API_KEY` / `WEB_SEARCH_MAX_RESULTS` / `WEB_SEARCH_TIMEOUT_MS` | - / 4 / 8000 | tavily key / 兜底抓取条数 / 单次搜索超时 |
| `RATE_LIMIT_MAX` / `CHAT_RATE_LIMIT_MAX` | 120 / 20 | 每分钟限流 |
| `FALLBACK_DIRECT` | true | 知识库为空时通用知识直答（注明） |
| `MEMORY_WINDOW` | 20 | 会话窗口条数（更早消息滚动摘要压缩） |
| `JWT_SECRET` | dev-insecure-secret | JWT 签名密钥，生产必须改随机长串 |
| `AUTH_USERS` | - | 预置用户 `用户名:密码,用户名:密码`，启动播种（不配则无人能登录） |
| `LANGFUSE_*` | - | 配置即启用，不配为空壳 |
| `PHOENIX_ENABLED` / `PHOENIX_ENDPOINT` | false | OTel → Phoenix |

## API 与 SSE 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录 → `{token}`（唯一开放的写入口，限流 10/min） |
| POST | `/api/documents` | multipart 上传，202 入队（`duplicated: true` 表示重复） |
| GET | `/api/documents` | 列表含 `status`(pending/processing/ready/failed)，仅本人文档 |
| GET | `/api/documents/events` | 摄取进度 SSE（`docs` 快照 + `doc` 单文档进度%），仅本人文档 |
| DELETE | `/api/documents/:id` | 先删向量再删元数据；摄取中返回 409；他人文档 404 |
| POST | `/api/chat` | `{question, topK, sessionId?, docId?}` → SSE；docId 限定单文档检索 |
| GET | `/api/sessions` · `/:id/messages` · DELETE | 会话管理（按用户隔离，他人会话 404） |
| GET | `/api/debug/retrieval?q=&topK=` | 裸检索观测（评估数据源/调参用） |
| GET | `/api/health` | 健康检查（开放，供容器探活） |

除 `/api/auth/login` 与 `/api/health` 外，所有接口需 `Authorization: Bearer <token>`。知识库检索是共享池（团队知识库语义）：文档管理面按用户隔离，向量检索不做用户过滤。

`POST /api/chat` 事件流：`step`(action/observation，时间线) → `sources`(来源卡片，带全局引用编号) → `delta`(正文 token) ｜ `reasoning`(思维链 token，独立通道) → `usage`(轮次/token/耗时) → `done`(stopReason: normal/max_iter/abort/error) ｜ `error`。

## 回归与评估

```bash
# 行为红线（快，CI 每次跑）：6 类坏用例断言，失败退出码 1
node scripts/regression.mjs          # 需先起服务；自动以 demo/demo123 登录
AUTH_USER=alice AUTH_PASS=xxx node scripts/regression.mjs    # 换账号
BASE_URL=http://localhost:8080 node scripts/regression.mjs   # 打容器栈

# 质量水位（M6）：evals/golden.jsonl 34 题 + 8 fixture 文档（自动上传，幂等）
node scripts/evaluate.mjs --layer retrieval   # 检索层：recall@k / MRR / purity（零 LLM，秒级）
node scripts/evaluate.mjs                     # 全量：+ 答案层 mustOk / faithfulness / relevance（LLM judge）
node scripts/evaluate.mjs --baseline evals/results/<旧档>.json   # 与基线对比（调参前后 A/B）
node scripts/evaluate.mjs --detail            # 逐题明细（期望缺失/干扰混入/忠实度问题逐条归因）
node scripts/evaluate.mjs --layer retrieval --assert "recall>=0.85,mrr>=0.7,purity=1"  # 阈值门禁（CI 已挂）
```

检索调参流程：改 `RETRIEVE_MIN_SCORE` / chunk 策略 / rerank 前跑一次存基线，改完 `--baseline` 对比数字。基线（34 题扩容集）：recall@5=1.0，MRR=0.985，purity=1，mustOkRate=1，faithfulness=0.994（竞争文档歧义题 mrr=0.5，是 rerank 实验的靶子）。注意：批量摄取后等 Qdrant 索引优化结束再评估，否则 HNSW 未收敛数字会抖。

M8 rerank 实验结论（`scripts/rerank-exp.mjs`，34 题 × 5 组合）：dbsf / 召回池×8 / dense 精排三种服务端策略 MRR 均在 0.971~0.985 打平（差异=1 题 rank，无显著性），**歧义题 rr=0.50 在所有策略下不变——「旧版检索基线」块语义字面双近，属语料级歧义，服务端排序无解**，后续方向是 cross-encoder 客户端 rerank 或语料治理。实验参数保留为 `RETRIEVE_FUSION` / `RETRIEVE_PREFETCH_MUL` 开关，默认维持 rrf。实验顺带修了两个潜伏 bug：dense-fallback 退化查询缺 `using:'dense'`（命名向量集合下必 400）；warn 现在带服务端 detail。

M9 cross-encoder 实验结论（[reranker.js](backend/src/rag/reranker.js) + `rerank-exp.mjs`，bge-reranker-base q8 本地 CPU）：召回池 20 → CE 重排 top5，**MRR 反降（0.985→0.934）、Q1 仍 rr=0.50、时延 5.5s/题——不接入生产**。Q1 的 CE logit 分布给出根因实锤：「旧版检索基线·已知问题」块（罗列纯向量检索缺点）logit 最高 3.62——它语义上真的在回答「为什么纯向量不好」；而正确答案块「混合检索原理」logit=-1.86 排第 9。**题目「检索用什么模式？为什么比纯向量好」在当前语料下存在双解读，多种「相关」都成立**——这是题目/语料设计问题，任何排序器都无解；正解是语料治理（旧版文档加显式废弃标注）或题目拆分。reranker.js 与 `RERANK_MODEL`/`RERANK_DTYPE` 配置保留为实验工具。

## 已知坑（复盘）

1. `@qdrant/js-client-rest@1.19`：`upsert` 需 `{points:[...]}` 包装；`search()` 已删除改 `query()`（返回 `{points}`）
2. otel v2 移除 `Resource` 类，用 `resourceFromAttributes()`
3. node:24-slim 中 better-sqlite3 回退 node-gyp：Dockerfile 需 `python3 make g++`
4. nginx 反代 SSE 必须 `proxy_buffering off`，否则流式变一次性输出
5. SSE 误判断开：POST 体读完 `req.raw` 也会 close，需 `writableEnded` 守卫
6. `@node-rs/jieba` 必须显式 `Jieba.withDict` 加载词典，否则中文全切成单字，BM25 稀疏向量失效

## 目录

```
backend/src/  server·config·auth·llm·schema ｜ routes/(auth·chat·documents·sessions·debug·health)
              rag/(parser·chunker·embedder·tokenizer·qdrant·ingest)
              agent/(graph·search-graph·tools·prompts·memory) ｜ store/sqlite ｜ obs/otel
frontend/src/ App ｜ components/(Login·ChatTab·DocsTab) ｜ api(token + SSE 解析)
scripts/      regression.mjs（回归）· evaluate.mjs（评估）
evals/        golden.jsonl（34 题标注）· fixtures/（8 文档）· results/（基线存档）
.github/      workflows/ci.yml（回归 + 镜像构建）
docs/         功能演进时间线.md
```

设计取舍与演进方向详见 [docs/功能演进时间线.md](docs/功能演进时间线.md)。
