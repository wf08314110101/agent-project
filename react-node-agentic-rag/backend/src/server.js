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
import { seedUsers, initAuthCache, currentTokenVer } from './auth.js'
import { initAnswerCache } from './rag/answer-cache.js'
import { applyDomain, packs } from './domain/registry.js'
import healthRoutes from './routes/health.js'
import authRoutes from './routes/auth.js'
import documentRoutes from './routes/documents.js'
import chatRoutes from './routes/chat.js'
import sessionRoutes from './routes/sessions.js'
import stagingRoutes from './routes/staging.js'
import approvalRoutes from './routes/approvals.js'
import debugRoutes from './routes/debug.js'
import adminRoutes from './routes/admin.js'
import { initObs, flushObs } from './obs/otel.js'
import mcpHttpPlugin from './mcp/http.js'

// 启动统一观测层：一次埋点按配置扇出（PHOENIX_ENABLED / LANGFUSE_* 三项）
initObs()

const app = Fastify({
  logger: { level: 'info' },          // 内置 pino 日志，info 级别
  bodyLimit: 32 * 1024 * 1024,        // JSON 请求体上限 32MB（文件走 multipart，另有独立限制）
})
// 在途 SSE 流登记表：优雅退出时统一 abort，避免 app.close() 被长连接卡死（chat.js 注册/注销）
app.decorate('sseStreams', new Set())

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
initAuthCache(redis) // M14：token_ver 校验的多实例共享缓存（未配 Redis 退回进程内存）
initAnswerCache(redis) // ID6：回答缓存共享态（多实例同 Key TTL 一致；未配 Redis 退回进程内存）

// ---- JWT 鉴权 ----
if (process.env.JWT_SECRET) {
  app.log.info('[auth] JWT_SECRET 已配置')
} else {
  app.log.warn('[auth] JWT_SECRET 未配置，使用开发期兜底密钥——生产必须显式设置！')
}
await app.register(jwt, { secret: config.auth.jwtSecret })
// authenticate 装饰器（M14 无状态化）：JWT 携带 role/dept/ver，不再每请求查库；
// 只比对 token_ver（两级缓存：Redis/内存 → pg 兜底），改权限 bump ver → 旧 token 立即 401
app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify()
  } catch {
    return reply.code(401).send({ error: '未登录或登录已过期，请重新登录' })
  }
  const ver = await currentTokenVer(req.user.sub)
  if ((req.user.ver ?? 0) !== ver) {
    return reply.code(401).send({ error: '权限已变更，请重新登录' })
  }
  // role/dept 直接取 JWT payload（签发时查库写入，权限变更经 ver 失效保证不过期使用）
  req.user = { sub: req.user.sub, username: req.user.username, role: req.user.role || 'member', dept: req.user.dept || '' }
})

// 预置用户播种：AUTH_USERS → users 表（scrypt 哈希，幂等）
await seedUsers(app.log)

// M17 领域包激活：标签词表/切分器/提示片段注入（在任何路由请求前完成）
await applyDomain(app.log)

// ---- 业务路由 ----
app.register(healthRoutes)    // GET  /api/health          健康检查（开放，供容器探活）
app.register(authRoutes)      // POST /api/auth/login      登录（开放，限流单独收紧）

// 受保护路由组：挂 authenticate 钩子，组内所有路由需携带有效 JWT
const protectedRoutes = async (api) => {
  api.addHook('preHandler', app.authenticate)
  api.register(documentRoutes)  // 文档上传 / 列表 / 删除 / 密级标签授权
  api.register(sessionRoutes)   // 会话列表 / 消息回放 / 删除
  api.register(chatRoutes)      // POST /api/chat            SSE 流式问答（核心）
  api.register(stagingRoutes)   // M20 对话内暂存上传（写工具数据源）
  api.register(approvalRoutes)  // M20 写审批：确认执行 / 拒绝 / 查询
  api.register(debugRoutes)     // GET  /api/debug/retrieval 裸检索观测（评估/调参）
  api.register(adminRoutes)     // 用户管理（admin only）
}
app.register(protectedRoutes)

// M13 MCP Server：配置 MCP_HTTP_TOKEN 才挂 POST /mcp（Streamable HTTP + Bearer 鉴权）
if (config.mcp.enabled && config.mcp.httpToken) {
  app.register(mcpHttpPlugin)
  app.log.info('[mcp] Streamable HTTP → POST /mcp（Bearer 鉴权已启用）')
}

// 摄取 worker：单并发后台消费 pending 文档
// 单并发原因：嵌入是 CPU 密集操作（transformers.js），多并发会互相争抢 CPU
const ingest = createIngestWorker(app.log)
await ingest.start()

// 启动即确保集合存在（幂等；Qdrant 未就绪不阻塞启动，上传时会再 ensure）
// M17：core 集合 + 各激活领域包集合一次 ensure（领域包删除集合即随包下线）
try {
  await ensureCollection()
  for (const p of packs) await ensureCollection({ collection: p.collection })
} catch (e) {
  app.log.warn(`[qdrant] 启动检查失败: ${e.message}`)
}

// ---- 优雅退出：停 worker → abort 在途 SSE（终止上游 LLM，放行长连接）→ 关 HTTP → 收尾退出 ----
let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(1)       // 二次信号：放弃等待，立即强退
    closing = true
    const force = setTimeout(() => process.exit(1), 10_000) // 兜底：优雅关闭 10s 未完成则强退
    try {
      await ingest.stop()              // 不再领取新摄取任务
      for (const a of app.sseStreams) a.abort()
      await app.close()                // 等待在途请求收尾
      clearTimeout(force)
    } catch (e) {
      app.log.error(`[shutdown] ${e.message}`)
    }
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
