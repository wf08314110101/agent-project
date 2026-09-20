// ============================================================================
// 全局配置模块：集中读取环境变量并导出一份不可变的配置对象
// ----------------------------------------------------------------------------
// 作用：
//   1. 进程启动时通过 `dotenv/config` 自动加载 backend/.env 文件到 process.env；
//   2. 所有模块统一从这里取配置，避免散落各处直接读 process.env；
//   3. 每个配置项都提供合理的默认值，保证"零配置"也能跑起来（本地开发友好）。
// 读取优先级：真实环境变量 > .env 文件 > 代码内默认值
// ============================================================================

import 'dotenv/config'

// 读取字符串环境变量，k 为变量名，d 为缺省值（两者都允许 undefined）
const env = (k, d) => process.env[k] ?? d

// 读取整型环境变量：统一转成十进制数字，解析失败得到 NaN（由调用方兜底）
const int = (k, d) => Number.parseInt(env(k, String(d)), 10)

export const config = {
  // ---- HTTP 服务 ----
  port: int('PORT', 8788),                 // Fastify 监听端口
  corsOrigin: env('CORS_ORIGIN', true),    // CORS 允许的来源；true = 反射任意 Origin（开发期方便）
  uploadMaxMb: int('UPLOAD_MAX_MB', 20),   // 单个上传文件大小上限（MB），同时用于 multipart 限制与 413 提示

  // ---- 存储层 ----
  qdrantUrl: env('QDRANT_URL', 'http://localhost:6333'),      // Qdrant 向量数据库 REST 地址
  qdrantCollection: env('QDRANT_COLLECTION', 'agentic_docs'), // 向量集合名（一个知识库一个集合）
  pg: {
    url: env('DATABASE_URL', 'postgres://rag:rag123@localhost:5432/rag'), // Postgres 连接串（文档元数据/会话/消息）
  },
  // ---- M12 多实例共享态（可选）：非空即启用（限流计数共享 + 摄取事件广播），缺省退回进程内存 ----
  redis: {
    url: env('REDIS_URL', ''),
  },
  uploadsDir: env('UPLOADS_DIR', './data/uploads'),           // 摄取原件暂存（M17 起摄取完成后保留，供预览接口读原文）

  // ---- 限流（每分钟）：全局 + chat 单独收紧 ----
  rate: {
    globalMax: int('RATE_LIMIT_MAX', 120),      // 全局限流：所有路由合计 120 次/分钟/IP
    chatMax: int('CHAT_RATE_LIMIT_MAX', 20),    // chat 路由单独 20 次/分钟（LLM 调用成本高，需更严）
  },

  // ---- 降级策略：知识库无资料时允许 LLM 基于通用知识直答（回答需注明来源）----
  fallbackDirect: env('FALLBACK_DIRECT', 'true') === 'true',

  // ---- LLM（OpenAI 兼容协议，默认指向 DeepSeek）----
  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://api.deepseek.com/v1'), // OpenAI 兼容 API 的 base URL
    apiKey: env('LLM_API_KEY', ''),                              // API Key（必填才能真正调通）
    model: env('LLM_MODEL', 'deepseek-chat'),                    // 对话模型名
  },

  // ---- 嵌入模型：local = 本地 CPU transformers.js；openai = OpenAI 兼容 /embeddings 端点（硅基流动等）----
  // 切换 provider 时 EMBED_DIM 必须与新模型输出维度一致（Qdrant 集合维度建后不可改，需重建集合）
  embed: {
    provider: env('EMBED_PROVIDER', 'local'),               // local | openai
    model: env('EMBED_MODEL', 'Xenova/bge-small-zh-v1.5'), // 本地模型（provider=local）
    dim: int('EMBED_DIM', 512),                            // 向量维度，必须与 Qdrant 集合定义一致
    device: env('EMBED_DEVICE', 'cpu'),                    // 推理设备（transformers.js 支持 cpu/webgpu 等）
    endpoint: env('HF_ENDPOINT', 'https://hf-mirror.com'), // 模型下载镜像（国内访问 HuggingFace 加速）
    apiModel: env('EMBED_API_MODEL', ''),                  // provider=openai 必填（如 BAAI/bge-m3）
    apiBaseUrl: env('EMBED_API_BASE_URL', ''),             // 空 = 复用 LLM_BASE_URL
    apiKey: env('EMBED_API_KEY', ''),                      // 空 = 复用 LLM_API_KEY
  },

  // ---- 检索阈值：相似度低于该分数的结果直接丢弃（粗过滤噪声）----
  retrieveMinScore: Number(env('RETRIEVE_MIN_SCORE', '0.3')),
  // ---- M8 rerank 实验开关：服务端融合算法与召回池大小（实验结论写入 README 后固化默认值）----
  retrieveFusion: env('RETRIEVE_FUSION', 'rrf'),        // rrf（排名融合，默认）| dbsf（绝对分融合，1.11+）
  retrievePrefetchMul: Number(env('RETRIEVE_PREFETCH_MUL', '0')), // 召回池倍率，0 = 默认 max(k*3, 12)

  // ---- M9 cross-encoder rerank（客户端精排）----
  rerank: {
    model: env('RERANK_MODEL', 'Xenova/bge-reranker-base'), // 中英 cross-encoder（Xenova ONNX 转换）
    dtype: env('RERANK_DTYPE', 'q8'),                       // 量化精度：q8 体积小速度快，fp32 更准
  },

  // ---- Qdrant 存储调优（ID7）：建集合时生效，存量集合需删除重建才应用 ----
  qdrant: {
    quantile: Number(env('QDRANT_QUANTILE', '0.99')), // int8 标量量化分位（0.99 保留极端值）；0 = 关闭量化
    hnswM: int('QDRANT_HNSW_M', 16),                  // HNSW 每节点最大边数（越大召回越准、内存越高）
    hnswEfConstruct: int('QDRANT_HNSW_EF_CONSTRUCT', 128), // 建索引候选队列长度（越大索引质量越高、建库越慢）
    hnswEf: int('QDRANT_HNSW_EF', 0),                 // 查询侧 ef；0 = 不传（服务端默认）
  },

  // ---- 回答缓存（ID6）：键 = 问题+ACL指纹+KB纪元；命中直接 SSE 回放完整答案 ----
  answerCache: { ttlSec: int('ANSWER_CACHE_TTL_SEC', 1800) }, // 0 = 关闭

  // ---- Agent 行为控制 ----
  agent: {
    maxIterations: int('AGENT_MAX_ITERATIONS', 6),   // 主图最大轮数（防死循环；超过则强制直答）
    searchMaxAttempts: int('SEARCH_MAX_ATTEMPTS', 2), // search_kb 子图最大"改写→重检"尝试次数
    queryRewrite: env('QUERY_REWRITE', 'false') === 'true', // ID7：首跳检索前 LLM 改写/关键词化（增 ~1s 延迟）
  },

  // ---- 网络搜索兜底（CRAG：库内重试额度用尽仍不足时联网补救）----
  webSearch: {
    provider: env('WEB_SEARCH_PROVIDER', 'bing'), // bing（免 key 抓取）| tavily（需 key）| off（关闭兜底）
    tavilyKey: env('TAVILY_API_KEY', ''),         // tavily provider 的 API Key
    maxResults: int('WEB_SEARCH_MAX_RESULTS', 4), // 兜底抓取条数（并入资料后仍过 grade 过滤）
    timeoutMs: int('WEB_SEARCH_TIMEOUT_MS', 8000), // 单次搜索超时（超时/失败降级为无兜底资料）
  },

  // ---- 长会话记忆压缩 ----
  memory: {
    windowSize: int('MEMORY_WINDOW', 20), // 回放窗口：最近 N 条原文恒在上下文（+未压缩真空区，零丢失）
  },

  // ---- 鉴权（M5 方案 C：预置用户 + JWT 登录；M14 起 access 短效 + refresh 旋转 + token_ver 即刻失效）----
  auth: {
    // JWT 签名密钥：生产必须显式配置；缺省时仅给开发期兜底值（启动时会打警告）
    jwtSecret: env('JWT_SECRET', 'dev-insecure-secret'),
    // access token 有效期：短效无状态（role/dept 进 JWT，改权限靠 token_ver 失效旧 token）
    accessTtl: env('JWT_ACCESS_TTL', '15m'),
    // refresh token 有效期（天）：旋转复用，落库 sha256 哈希（users 表单活 token 模型）
    refreshDays: Number(env('JWT_REFRESH_DAYS', '30')),
    // 预置用户清单：'用户名:密码[:角色[:部门]]'，如 'demo:demo123,alice:alice123:member:研发,boss:boss123:admin'
    // 角色 member|admin（admin 可见全部文档并管理用户）；部门为字符串编码（如 研发/销售），留空则 dept 级文档对其不可见
    users: String(env('AUTH_USERS', ''))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const p = s.split(':')
        return { username: p[0], password: p[1] ?? '', role: p[2] || 'member', dept: p[3] || '' }
      })
      .filter((u) => u.username && u.password),
  },

  // ---- Langfuse 观测（可选）：三项都配置才启用，用于 trace/generation 记录 ----
  langfuse: {
    host: env('LANGFUSE_HOST', ''),
    publicKey: env('LANGFUSE_PUBLIC_KEY', ''),
    secretKey: env('LANGFUSE_SECRET_KEY', ''),
  },
  // ---- M13 MCP Server（知识库服务化）：全部工具只读，走 canReadDoc/aclFor 同源 ACL ----
  mcp: {
    enabled: env('MCP_ENABLED', 'true') === 'true',
    accessUser: env('MCP_ACCESS_USER', ''),  // 服务身份用户名（AUTH_USERS 里的预置用户）；空 = 仅 public 匿名
    httpToken: env('MCP_HTTP_TOKEN', ''),    // 非空才挂 POST /mcp（Streamable HTTP + Bearer）；stdio 入口不受此项控制
  },
  // ---- Phoenix 观测（可选）：OpenTelemetry → Phoenix，默认关闭 ----
  phoenixEnabled: env('PHOENIX_ENABLED', 'false') === 'true',
  phoenixEndpoint: env('PHOENIX_ENDPOINT', 'http://localhost:6006/v1/traces'), // Phoenix 的 OTLP 接收端点

  // ---- M17 领域包：单激活（DOMAIN_PACKS=api-docs），空 = 纯 core 行为（零破坏面）----
  domain: {
    packs: env('DOMAIN_PACKS', ''),                  // 启用的领域包名列表（逗号分隔）
    syncIntervalMin: int('DOMAIN_SYNC_INTERVAL_MIN', 0), // 连接器定时同步间隔（分钟）；0 = 仅手动 npm run domain:sync
    githubToken: env('GITHUB_TOKEN', ''),            // GitHub API Token（可选，防 60 次/h 限流）
  },
}
