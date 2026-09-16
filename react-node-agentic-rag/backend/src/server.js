// ============================================================================
// 服务入口：组装 Fastify 应用、注册插件与路由、启动摄取 worker、优雅退出
// ----------------------------------------------------------------------------
// 启动流程：
//   1. initOtel()            → 可选开启 OTel → Phoenix 链路观测
//   2. 创建 Fastify 实例      → 日志 + 请求体上限
//   3. 注册 cors/multipart/rate-limit 插件
//   4. 注册 4 组业务路由      → health / documents / sessions / chat
//   5. 启动摄取 worker        → 单并发后台消费 pending 文档（解析→切块→嵌入→入库）
//   6. ensureCollection()    → 幂等确保 Qdrant 集合存在（失败不阻塞启动）
//   7. 监听端口，开始对外服务
// 退出流程：SIGINT/SIGTERM → 停 worker → 关闭 HTTP → process.exit(0)
// ============================================================================

import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart' // 文件上传（multipart/form-data）支持
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import Redis from 'ioredis'
import { config } from './config.js'
import { ensureCollection } from './rag/qdrant.js'
import { createIngestWorker } from './rag/ingest.js'
import { closeBus } from './rag/bus.js'
import { seedUsers } from './auth.js'
import { getUserById } from './store/pg.js'
import healthRoutes from './routes/health.js'
import authRoutes from './routes/auth.js'
import documentRoutes from './routes/documents.js'
import chatRoutes from './routes/chat.js'
import sessionRoutes from './routes/sessions.js'
import debugRoutes from './routes/debug.js'
import adminRoutes from './routes/admin.js'
import { initObs, flushObs } from './obs/otel.js'

// 启动统一观测层：一次埋点按配置扇出（PHOENIX_ENABLED / LANGFUSE_* 三项）
initObs()

const app = Fastify({
  logger: { level: 'info' },          // 内置 pino 日志，info 级别
  bodyLimit: 32 * 1024 * 1024,        // JSON 请求体上限 32MB（文件走 multipart，另有独立限制）
})

// ---- 插件注册（await 确保顺序：cors/multipart/rate-limit 先于路由生效）----
await app.register(cors, { origin: config.corsOrigin })
await app.register(multipart)
// M12 限流共享：配 REDIS_URL 时计数走 Redis（多实例全局限流一致），缺省退回进程内存
const rateLimitOpts = {
  global: true,                        // 全局限流对所有路由生效
  max: config.rate.globalMax,          // 每分钟最大请求数
  timeWindow: '1 minute',
}
let redis = null
if (config.redis.url) {
  redis = new Redis(config.redis.url, { maxRetriesPerRequest: 2 })
  redis.on('error', (e) => app.log.error(`[redis] 限流连接错误: ${e.message}`))
  rateLimitOpts.redis = redis
  app.log.info(`[redis] 限流/事件共享已启用 → ${config.redis.url}`)
}
await app.register(rateLimit, rateLimitOpts)

// ---- JWT 鉴权 ----
if (process.env.JWT_SECRET) {
  app.log.info('[auth] JWT_SECRET 已配置')
} else {
  app.log.warn('[auth] JWT_SECRET 未配置，使用开发期兜底密钥——生产必须显式设置！')
}
await app.register(jwt, { secret: config.auth.jwtSecret })
// authenticate 装饰器：校验 Bearer token；M10 起 role/dept 每请求查库（JWT 不缓存权限，改角色即刻生效）
app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify()
  } catch {
    return reply.code(401).send({ error: '未登录或登录已过期，请重新登录' })
  }
  const u = await getUserById(req.user.sub)
  if (!u) return reply.code(401).send({ error: '用户不存在，请重新登录' })
  req.user = { sub: u.id, username: u.username, role: u.role || 'member', dept: u.dept || '' }
})

// 预置用户播种：AUTH_USERS → users 表（scrypt 哈希，幂等）
await seedUsers(app.log)

// ---- 业务路由 ----
app.register(healthRoutes)    // GET  /api/health          健康检查（开放，供容器探活）
app.register(authRoutes)      // POST /api/auth/login      登录（开放，限流单独收紧）

// 受保护路由组：挂 authenticate 钩子，组内所有路由需携带有效 JWT
const protectedRoutes = async (api) => {
  api.addHook('preHandler', app.authenticate)
  api.register(documentRoutes)  // 文档上传 / 列表 / 删除 / 密级标签授权
  api.register(sessionRoutes)   // 会话列表 / 消息回放 / 删除
  api.register(chatRoutes)      // POST /api/chat            SSE 流式问答（核心）
  api.register(debugRoutes)     // GET  /api/debug/retrieval 裸检索观测（评估/调参）
  api.register(adminRoutes)     // 用户管理（admin only）
}
app.register(protectedRoutes)

// 摄取 worker：单并发后台消费 pending 文档
// 单并发原因：嵌入是 CPU 密集操作（transformers.js），多并发会互相争抢 CPU
const ingest = createIngestWorker(app.log)
await ingest.start()

// 启动即确保集合存在（幂等；Qdrant 未就绪不阻塞启动，上传时会再 ensure）
try {
  await ensureCollection()
} catch (e) {
  app.log.warn(`[qdrant] 启动检查失败: ${e.message}`)
}

// ---- 优雅退出：先停 worker（不再取新任务）→ 关闭 HTTP（等待在途请求）→ 退出 ----
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await ingest.stop()
    await app.close()
    if (redis) redis.disconnect()
    await closeBus() // 冲刷/关闭 Redis pub-sub 连接
    await flushObs() // 冲刷观测队列，防止尾部 span 丢失
    process.exit(0)
  })
}

// 监听 0.0.0.0（允许容器/局域网访问），启动失败则打日志并以非零码退出
app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => app.log.info(`API → http://localhost:${config.port}`))
  .catch((e) => {
    app.log.error(e)
    process.exit(1)
  })
