# Agentic RAG（React + Node.js）

生产形态的 Agentic RAG 参考实现：Agent 自主决策「何时检索、检索什么、结果不足时改写重检」，全链路可观测，坏用例可回归。

参考姊妹项目：`react-python-rag`（单路 RAG 基线）、`react-react-agent`（ReAct Agent 基线）。

## 架构

```
React 5174 ──SSE── Fastify 8788 ──┬── DeepSeek (LLM, 工具调用)
  ChatTab: 步骤时间线/来源卡片      │
  DocsTab: 上传+状态轮询            ├── LangGraph 主图: agent ⇄ tools (ReAct loop)
                                   │      └─ search_kb 子图: retrieve → grade → rewrite
                                   ├── Qdrant 6333 (向量) ←─ 嵌入: 本地 bge ONNX ｜ 远程 /embeddings (EMBED_PROVIDER)
                                   ├── Postgres 5432 (文档/会话/消息) ｜ Redis 6379 (可选，多实例共享态)
                                   └── MCP Server (M13) ←─ Cursor / Claude Code / Trae 等客户端直连检索
观测: OTel 单管道双导出 → Langfuse 云端 ｜ Phoenix (PHOENIX_ENABLED=true)
```

## 功能

- **摄取队列**：上传即 202 入队，worker 后台解析→切块→嵌入（分批上报进度%），SSE 实时推送状态（断线自动回退轮询）；同内容 hash 去重；宕机自恢复
- **混合检索**：稠密（bge 语义）+ 稀疏（jieba 分词 BM25）双路 Qdrant 服务端 RRF 融合，关键词/专名查询不丢召回
- **Agentic 检索**：多查询并发检索 + LLM 逐条相关性评估（结果缓存）+ 材料不足自动改写重检（CRAG，有界 2 次）；可选首跳查询改写（`QUERY_REWRITE=on`，检索前先优化查询，不计入重试额度）
- **回答缓存（M15）**：同问题 + 同可见资料（KB 纪元）+ 同 ACL 指纹命中直接 SSE 回放（`stopReason=cache`，先落库再回放），省检索/评估/LLM 全链路；文档增删、密级授权变更纪元 +1 全量失效，杜绝脏读；Redis 共享多实例，`ANSWER_CACHE_TTL_SEC=0` 关闭
- **工具调用**：search_knowledge / calculator / get_current_time；参数 schema 校验门、同参重复调用检测、同批多工具并行执行；超 6 轮强制直答防死循环
- **引用锚点**：检索块全局唯一编号，回答行内 [n] 可点击跳转对应来源卡片；指定文档问答（DocsTab「提问」→ 仅在该文档范围、按其所属集合定向检索）
- **文档预览（M17）**：摄取原件保留（不再处理完即删），`GET /api/documents/:id/content` 原样回传（canReadDoc 鉴权，pdf 浏览器原生渲染，文本类 text/plain，html 不 inline 防 XSS），前端点文件名新标签页预览
- **语料时效与冲突治理（M18）**：文档版本组 `docKey` + `docVersion/effectiveDate` 元数据贯通（上传 → payload → 检索 → 前端徽标）；同 docKey 重传自动**版本化替换**（`DOC_REPLACE_MODE=off|auto|on`，默认 core 关、领域集合开）；检索层**版本消解**（同组旧版块剔除，最新版全量保留；docId 定向旧版仍可查）+ **deprecated 降权**（`DEPRECATED_PENALTY=0.3`，降权非硬滤）；grade 增 `conflict` 冲突标记，答案按版本取舍或列明双方
- **会话**：多轮上下文（超窗滚动摘要压缩，seq 断点零丢失）、消息+步骤+来源持久化回放、会话增删
- **思维链通道**：reasoning token 走独立 SSE 事件（deepseek-reasoner 等模型自动生效），前端折叠面板展示，不与正文混流
- **鉴权**：预置用户 + JWT 登录（scrypt 存储密码），会话/文档按用户隔离；登录接口单独限流
- **无状态鉴权（M14）**：access JWT 短效（payload 携带 role/dept/ver，authenticate 零查库）+ token_ver 即刻失效（改权限 bump，旧 token 立即 401，ver 走 Redis/内存两级缓存）+ refresh token 单活旋转（sha256 落库，前端 401 自续期重放）
- **Prompt 防注入（M16）**：检索资料/联网兜底包进随机 nonce 定界符（防伪造闭合）+ 系统提示声明「定界内皆数据」；输出侧检测系统提示泄露（命中即拒答 + span 告警）；入口注入句式打标进 trace（`rag.injection_suspect`）供审计，不拒绝（防误杀）
- **可观测**：单一 OTel 管道双导出——Langfuse trace/span/usage + Phoenix OpenInference，一次埋点两平台同构
- **MCP 服务化（M13）**：知识库暴露为 MCP Server，Cursor/Claude Code/Trae/Inspector 等客户端直连检索；4 个只读工具 + 全文 Resource，双传输 stdio（独立进程）/ Streamable HTTP（Bearer）；ACL 与 Web 端同源（canReadDoc/aclFor，密级召回前过滤）
- **领域包（M17）**：通用层冻结，业务知识可插拔——`backend/src/domain/` 一包一目录自包含五件套（语料结构/切分策略/提示片段/工具集/评测集），经 registry 单点拼装（工具表/标签词表/切分器/提示片段四注入点），内核零领域知识；`DOMAIN_PACKS` 单激活，留空 = 纯 core 行为零破坏；一领域一 Qdrant 集合（payload 机制 schema 全局统一），KB 纪元按集合分桶缓存互不清；`GET /api/meta` 动态下发当前标签词表（前端编辑器/筛选器随包适配）；首个包 `api-docs`：GitHub md 连接器（hash 判重 + 版本化替换 + 废弃标注）+ 领域工具 fetch_api_doc + 900 字文档切分
- **生产防线**：限流（全局 120/min、chat 20/min、login 10/min）、知识库为空降级直答、坏用例回归脚本、容器化部署（compose 健康检查依赖）、CI（回归 + 镜像构建）、优雅退出（在途 SSE 登记 abort + 10s 兜底强退 + 二次信号即退）

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
| `EMBED_MODEL` / `EMBED_DIM` | Xenova/bge-small-zh-v1.5 / 512 | 本地嵌入（provider=local）；`EMBED_DIM` 必须与集合维度一致 |
| `EMBED_PROVIDER` / `EMBED_API_MODEL` | local / - | 嵌入 provider：`local`（本地 ONNX）/ `openai`（OpenAI 兼容 `/embeddings` 端点）；openai 必填 `EMBED_API_MODEL`，`EMBED_API_BASE_URL`/`EMBED_API_KEY` 缺省复用 LLM 配置；切换需同步 `EMBED_DIM` 并删除重建集合 |
| `HF_ENDPOINT` | hf-mirror.com | 模型下载镜像（国内） |
| `RETRIEVE_MIN_SCORE` | 0.3 | 稠密路相似度阈值（RRF 融合分不再二次过滤） |
| `AGENT_MAX_ITERATIONS` / `SEARCH_MAX_ATTEMPTS` | 6 / 2 | 主图轮数上限 / 检索重试上限 |
| `QUERY_REWRITE` | false | 首跳检索前 LLM 改写查询（多花 ~1s，召回更稳；不计入重试额度） |
| `ANSWER_CACHE_TTL_SEC` | 1800 | 回答缓存 TTL 秒（0 = 关闭），命中直接 SSE 回放（stopReason=cache） |
| `QDRANT_QUANTILE` / `QDRANT_HNSW_M` / `QDRANT_HNSW_EF_CONSTRUCT` / `QDRANT_HNSW_EF` | 0.99 / 16 / 128 / 0 | 建集合调优：int8 量化分位（0=关）/ HNSW m / ef_construct / 查询侧 ef（0=默认）；仅新建集合生效 |
| `WEB_SEARCH_PROVIDER` | bing | 网络兜底搜索源：bing（免 key）/ tavily（需 key）/ off（关闭） |
| `RETRIEVE_FUSION` / `RETRIEVE_PREFETCH_MUL` | rrf / 0 | 服务端融合算法（rrf / dbsf）/ 召回池倍率（M8 rerank 实验开关） |
| `TAVILY_API_KEY` / `WEB_SEARCH_MAX_RESULTS` / `WEB_SEARCH_TIMEOUT_MS` | - / 4 / 8000 | tavily key / 兜底抓取条数 / 单次搜索超时 |
| `RATE_LIMIT_MAX` / `CHAT_RATE_LIMIT_MAX` | 120 / 20 | 每分钟限流 |
| `FALLBACK_DIRECT` | true | 知识库为空时通用知识直答（注明） |
| `MEMORY_WINDOW` | 20 | 会话窗口条数（更早消息滚动摘要压缩） |
| `JWT_SECRET` | dev-insecure-secret | JWT 签名密钥，生产必须改随机长串 |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_DAYS` | 15m / 30 | access 短效期（M14 无状态校验）/ refresh 有效期天数（单活旋转） |
| `AUTH_USERS` | - | 预置用户 `用户名:密码[:角色[:部门]]`（M10），角色 member/admin；启动播种（不配则无人能登录） |
| `MCP_ENABLED` / `MCP_ACCESS_USER` / `MCP_HTTP_TOKEN` | true / - / - | MCP Server（M13）：服务身份用户名（空 = 仅 public 匿名）/ 非空才挂 `POST /mcp`（Bearer）；stdio 入口不受这两项控制 |
| `DOMAIN_PACKS` | 空 | 领域包单激活（M17，当前可选 `api-docs`）：主检索集合切 `rag_api_docs`、标签词表/切分策略/提示片段由包注入、上传接受 `collection=rag_api_docs`；留空 = 纯 core 零破坏 |
| `DOC_REPLACE_MODE` | `auto` | 版本化替换（M18）：同 docKey 重传内容变化时删旧插新（version+1）。`off`=不替换新旧共存 ｜ `on`=全集合替换 ｜ `auto`=core 关、领域集合开 |
| `DEPRECATED_PENALTY` | `0.3` | deprecated 文档命中融合分乘数（M18，降权非硬滤——明确问旧版仍可召回；1 = 不降权） |
| `DOMAIN_SYNC_INTERVAL_MIN` / `DOMAIN_SYNC_MAX_FILES` | 0 / 40 | 连接器定时同步间隔分钟（0 = 仅手动 `npm run domain:sync`）/ 单次最多摄取文件数 |
| `DOMAIN_SYNC_REPO` / `DOMAIN_SYNC_BRANCH` / `DOMAIN_SYNC_DIR` / `DOMAIN_SYNC_DEPRECATED_DIR` | vuejs-translations/docs-zh-cn / main / src/ / 空 | 同步源 GitHub md 仓库 / 分支 / 子目录 / 废弃区子目录（deprecated 标注） |
| `GITHUB_TOKEN` | - | GitHub API Token（可选，防匿名 60 次/h 限流） |
| `LANGFUSE_*` | - | 配置即启用，不配为空壳 |
| `PHOENIX_ENABLED` / `PHOENIX_ENDPOINT` | false | OTel → Phoenix |

## API 与 SSE 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录 → `{token}`（唯一开放的写入口，限流 10/min） |
| POST | `/api/documents` | multipart 上传（可带 `classification`/`tags`/`collection`/`docKey`/`effectiveDate`，M18 起同 docKey 重传按 `DOC_REPLACE_MODE` 版本化替换），202 入队（`duplicated: true` 表示重复） |
| GET | `/api/documents` | 可见集合：本人 ∪ public ∪ 同部门(dept) ∪ 被授权；admin 全量 |
| GET | `/api/documents/:id/content` | 原文预览：原样回传字节（pdf→application/pdf，其余→text/plain）；不可读/原件缺失 404 |
| GET | `/api/documents/events` | 摄取进度 SSE（`docs` 快照 + `doc` 单文档进度%），按可见性推送 |
| PATCH | `/api/documents/:id` | 密级/标签/授权（`grants`: 用户名数组）；owner 或 admin；ready 文档同步刷 Qdrant payload 即时生效 |
| DELETE | `/api/documents/:id` | 先删向量再删元数据；摄取中返回 409；不可读文档 404 |
| POST | `/api/chat` | `{question, topK, sessionId?, docId?}` → SSE；docId 走 canReadDoc 单点判定（不可读 404） |
| GET | `/api/sessions` · `/:id/messages` · DELETE | 会话管理（按用户隔离，他人会话 404） |
| GET | `/api/debug/retrieval?q=&topK=` | 裸检索观测（评估数据源/调参用），受 ACL 约束；带 docId 按文档所属集合定向 |
| GET | `/api/meta` | 公开元信息：当前生效标签词表（随领域包注入变化） |
| GET | `/api/admin/users` · PATCH `/:id` | 用户列表 / 调整角色部门（admin only） |
| GET | `/api/health` | 健康检查（开放，供容器探活） |

除 `/api/auth/login` 与 `/api/health` 外，所有接口需 `Authorization: Bearer <token>`。

**M10 RBAC**：密级三级 `public`（全体登录用户）/ `dept`（同归属人部门）/ `private`（仅 owner + 显式授权），受控标签枚举（技术方案/制度/会议纪要/运维/竞品/测试）。密级下沉为 Qdrant payload 在**召回前服务端过滤**（ownerId/classification/ownerDept），检索后隐藏等于没保护；`canReadDoc`（backend/src/acl.js）是唯一可读性判定单点，不可读一律 404 不泄露存在性；role/dept 签发进 JWT payload（M14 无状态校验），改权限 bump token_ver 即刻失效旧 token。PATCH 密级同步 `setPayload`，改完即生效无需重摄；启动时对无密级旧点位回填 public（保持升级前可见性）。新上传默认 private。

`POST /api/chat` 事件流：`step`(action/observation，时间线) → `sources`(来源卡片，带全局引用编号) → `delta`(正文 token) ｜ `reasoning`(思维链 token，独立通道) → `usage`(轮次/token/耗时) → `done`(stopReason: normal/max_iter/abort/error/cache) ｜ `error`。`stopReason=cache` 表示命中回答缓存直接回放（usage 为原答用量，rounds=0）。

## MCP 接入（M13）

知识库作为 MCP Server（`@modelcontextprotocol/sdk`），全部工具**只读**，ACL 与 Web 端同源（服务身份 = `MCP_ACCESS_USER` 指定的预置用户，未配置则仅 public）。

| 工具 | 说明 |
|------|------|
| `rag_search` | 混合检索（稠密+稀疏 RRF），ACL 召回前过滤；支持 `k`/`docId` |
| `rag_list_docs` | 服务身份可见文档列表（密级/标签/分块/状态） |
| `rag_doc_status` | 单文档摄取状态；不可读按 404 语义 |
| `rag_stats` | 文档数（按状态分组）+ 向量点数（30s TTL 缓存） |
| Resource `rag://docs/{docId}` | 文档全文（分块按 chunkIndex 拼回） |

**stdio（本地 IDE，无需后端在线）**——Cursor / Claude Code / Trae 的 mcpServers 配置：

```json
{ "mcpServers": { "rag-kb": {
    "command": "node",
    "args": ["/绝对路径/react-node-agentic-rag/backend/src/mcp/stdio.mjs"],
    "env": { "MCP_ACCESS_USER": "demo" }
}}}
```

**Streamable HTTP（团队共享/远程 agent）**——后端配 `MCP_HTTP_TOKEN=<token>` 启动后：

```bash
curl -X POST http://localhost:8788/mcp \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

冒烟验证：`node backend/scripts/mcp-smoke.mjs stdio`（或 `http`，需 8790 端口实例带 token；模拟 SDK Client 完整握手 + 4 工具 + resources）。

## 领域模式（M17）

```bash
# core 模式（默认）：行为与纯内核完全一致，DOMAIN_PACKS 留空即可

# 领域模式：启用 api-docs 包（API 文档助手）
DOMAIN_PACKS=api-docs npm start          # backend/.env 配置同效
npm run domain:sync                      # 手动同步 Vue 中文文档 → rag_api_docs（幂等）
                                         # 或 DOMAIN_SYNC_INTERVAL_MIN=1440 启用每日定时
# 上传/评测注入领域语料：multipart 带 collection=rag_api_docs（白名单校验）
```

启用后：主检索集合切到 `rag_api_docs`（问答/裸检索/MCP 同源切换；文档级 QA 按文档所属集合定向检索）、领域工具 `fetch_api_doc` 进工具表、领域提示片段（废弃接口不作为依据）追加系统提示、标签词表覆盖为包定义（前端经 `/api/meta` 动态获取，文档列表显示集合列 + 废弃标注）。删除包 = 停用 env + drop collection，数据零残留。新领域包照 `api-docs` 五件套复制（index/tools/chunker/prompts/connector/evals）+ registry 注册一行。

## 回归与评估

```bash
# 行为红线（快，CI 每次跑）：6 类坏用例断言，失败退出码 1
node scripts/regression.mjs          # 需先起服务；自动以 demo/demo123 登录
AUTH_USER=alice AUTH_PASS=xxx node scripts/regression.mjs    # 换账号
BASE_URL=http://localhost:8080 node scripts/regression.mjs   # 打容器栈

# 质量水位（M6，M17 起双轨）：core 62 题 + domain 业务 12 题，各自独立基线与门禁
node scripts/evaluate.mjs --layer retrieval            # 双轨检索层：recall@k / MRR / purity（零 LLM，秒级）
node scripts/evaluate.mjs --suite core                 # 只跑 core 轨（冻结 62 题，内核回归门禁）
node scripts/evaluate.mjs --suite domain               # 只跑 domain 轨（业务题，要求 DOMAIN_PACKS=api-docs 启动）
node scripts/evaluate.mjs                              # 全量：双轨 + 答案层 mustOk / faithfulness / relevance
node scripts/evaluate.mjs --baseline evals/results/<旧档>.json   # 与基线对比（调参前后 A/B）
node scripts/evaluate.mjs --detail                     # 逐题明细（期望缺失/干扰混入/忠实度问题逐条归因）
node scripts/evaluate.mjs --suite core --layer retrieval --assert "recall>=0.85,mrr>=0.7,purity=1"  # 阈值门禁（逐轨，CI 已挂）
```

检索调参流程：改 `RETRIEVE_MIN_SCORE` / chunk 策略 / rerank 前跑一次存基线，改完 `--baseline` 对比数字。基线（core 轨 62 题，M18）：recall@5=0.989，MRR=0.954，purity=1（竞争文档歧义题 Q1 为 M8 定性的语料级歧义，持续存在）。注意：批量摄取后等 Qdrant 索引优化结束再评估，否则 HNSW 未收敛数字会抖。

M8 rerank 实验结论（`scripts/rerank-exp.mjs`，34 题 × 5 组合）：dbsf / 召回池×8 / dense 精排三种服务端策略 MRR 均在 0.971~0.985 打平（差异=1 题 rank，无显著性），**歧义题 rr=0.50 在所有策略下不变——「旧版检索基线」块语义字面双近，属语料级歧义，服务端排序无解**，后续方向是 cross-encoder 客户端 rerank 或语料治理。实验参数保留为 `RETRIEVE_FUSION` / `RETRIEVE_PREFETCH_MUL` 开关，默认维持 rrf。实验顺带修了两个潜伏 bug：dense-fallback 退化查询缺 `using:'dense'`（命名向量集合下必 400）；warn 现在带服务端 detail。

M9 cross-encoder 实验结论（[reranker.js](backend/src/rag/reranker.js) + `rerank-exp.mjs`，bge-reranker-base q8 本地 CPU）：召回池 20 → CE 重排 top5，**MRR 反降（0.985→0.934）、Q1 仍 rr=0.50、时延 5.5s/题——不接入生产**。Q1 的 CE logit 分布给出根因实锤：「旧版检索基线·已知问题」块（罗列纯向量检索缺点）logit 最高 3.62——它语义上真的在回答「为什么纯向量不好」；而正确答案块「混合检索原理」logit=-1.86 排第 9。**题目「检索用什么模式？为什么比纯向量好」在当前语料下存在双解读，多种「相关」都成立**——这是题目/语料设计问题，任何排序器都无解；正解是语料治理（旧版文档加显式废弃标注）或题目拆分。reranker.js 与 `RERANK_MODEL`/`RERANK_DTYPE` 配置保留为实验工具。

## 已知坑（复盘）

1. `@qdrant/js-client-rest@1.19`：`upsert` 需 `{points:[...]}` 包装；`search()` 已删除改 `query()`（返回 `{points}`）
2. otel v2 移除 `Resource` 类，用 `resourceFromAttributes()`
3. node:24-slim 中 better-sqlite3 回退 node-gyp——M15 起移出生产依赖（保留 devDependencies 供迁移脚本），Dockerfile 不再装 `python3 make g++`
4. nginx 反代 SSE 必须 `proxy_buffering off`，否则流式变一次性输出
5. SSE 误判断开：POST 体读完 `req.raw` 也会 close，需 `writableEnded` 守卫
6. `@node-rs/jieba` 必须显式 `Jieba.withDict` 加载词典，否则中文全切成单字，BM25 稀疏向量失效
7. MCP stdio 传输：stdout 是 JSON-RPC 协议通道，入口必须把 `console.log` 重定向到 stderr（embedder/qdrant 是懒加载，日志在调用时才打）
8. 摄取状态枚举是 `pending/processing/ready/failed`（不是 `done`）；MCP Resource 列表按 `ready` 过滤

## 目录

```
backend/src/  server·config·auth·acl ｜ routes/(auth·chat·documents·sessions·debug·admin·health)
              rag/(parser·chunker·embedder·tokenizer·qdrant·ingest·retriever·reranker·websearch·answer-cache)
              agent/(graph·search-graph·tools·prompts·memory·injection) ｜ store/pg ｜ mcp/(mcp-server·stdio·http) ｜ obs/otel
              domain/(registry + api-docs 五件套：index·tools·chunker·prompts·connector·evals)  # M17 领域包
frontend/src/ App ｜ components/(Login·ChatTab·DocsTab) ｜ api(token + SSE 解析)
scripts/      regression.mjs（回归）· evaluate.mjs（评估，--suite 双轨）· backend/scripts/(mcp-smoke.mjs·domain-sync.mjs) · migrate-sqlite-to-pg.mjs（M11 迁移）
evals/        golden-core.jsonl（core 62 题标注）· fixtures/（10 文档 + 版本组 sidecar）· results/（基线存档）；domain 轨随包：domain/api-docs/evals/
.github/      workflows/ci.yml（回归 + 镜像构建）
docs/         功能演进时间线.md
```

设计取舍与演进方向详见 [docs/功能演进时间线.md](docs/功能演进时间线.md)。
