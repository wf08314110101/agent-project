import 'dotenv/config'

const env = (k, d) => process.env[k] ?? d
const int = (k, d) => Number.parseInt(env(k, String(d)), 10)

export const config = {
  port: int('PORT', 8788),
  corsOrigin: env('CORS_ORIGIN', true),
  uploadMaxMb: int('UPLOAD_MAX_MB', 20),

  qdrantUrl: env('QDRANT_URL', 'http://localhost:6333'),
  qdrantCollection: env('QDRANT_COLLECTION', 'agentic_docs'),
  sqlitePath: env('SQLITE_PATH', './data/app.db'),
  uploadsDir: env('UPLOADS_DIR', './data/uploads'), // 摄取队列暂存原件

  // 限流（每分钟）：全局 + chat 单独收紧
  rate: {
    globalMax: int('RATE_LIMIT_MAX', 120),
    chatMax: int('CHAT_RATE_LIMIT_MAX', 20),
  },

  // 降级：知识库无资料时允许基于通用知识直答（回答需注明）
  fallbackDirect: env('FALLBACK_DIRECT', 'true') === 'true',

  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://api.deepseek.com/v1'),
    apiKey: env('LLM_API_KEY', ''),
    model: env('LLM_MODEL', 'deepseek-chat'),
  },

  embed: {
    model: env('EMBED_MODEL', 'Xenova/bge-small-zh-v1.5'),
    dim: int('EMBED_DIM', 512),
    device: env('EMBED_DEVICE', 'cpu'),
    endpoint: env('HF_ENDPOINT', 'https://hf-mirror.com'), // 模型下载镜像（国内）
  },

  retrieveMinScore: Number(env('RETRIEVE_MIN_SCORE', '0.3')),

  agent: {
    maxIterations: int('AGENT_MAX_ITERATIONS', 6), // 主图最大轮数（防死循环）
    searchMaxAttempts: int('SEARCH_MAX_ATTEMPTS', 2), // search_kb 子图最大检索尝试
  },

  langfuse: {
    host: env('LANGFUSE_HOST', ''),
    publicKey: env('LANGFUSE_PUBLIC_KEY', ''),
    secretKey: env('LANGFUSE_SECRET_KEY', ''),
  },
  phoenixEnabled: env('PHOENIX_ENABLED', 'false') === 'true', // OTel → Phoenix
  phoenixEndpoint: env('PHOENIX_ENDPOINT', 'http://localhost:6006/v1/traces'),
}
