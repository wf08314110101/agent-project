import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { ensureCollection } from './rag/qdrant.js'
import { createIngestWorker } from './rag/ingest.js'
import healthRoutes from './routes/health.js'
import documentRoutes from './routes/documents.js'
import chatRoutes from './routes/chat.js'
import sessionRoutes from './routes/sessions.js'
import { initOtel } from './obs/phoenix.js'

initOtel() // PHOENIX_ENABLED=true 时启 OTel → Phoenix

const app = Fastify({
  logger: { level: 'info' },
  bodyLimit: 32 * 1024 * 1024,
})

await app.register(cors, { origin: config.corsOrigin })
await app.register(multipart)
await app.register(rateLimit, {
  global: true,
  max: config.rate.globalMax,
  timeWindow: '1 minute',
})
app.register(healthRoutes)
app.register(documentRoutes)
app.register(sessionRoutes)
app.register(chatRoutes)

// 摄取 worker：单并发后台消费 pending 文档
const ingest = createIngestWorker(app.log)
ingest.start()

// 启动即确保集合存在（幂等；Qdrant 未就绪不阻塞启动，上传时会再 ensure）
try {
  await ensureCollection()
} catch (e) {
  app.log.warn(`[qdrant] 启动检查失败: ${e.message}`)
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await ingest.stop()
    await app.close()
    process.exit(0)
  })
}

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => app.log.info(`API → http://localhost:${config.port}`))
  .catch((e) => {
    app.log.error(e)
    process.exit(1)
  })
