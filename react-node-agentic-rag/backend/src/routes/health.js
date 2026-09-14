// ============================================================================
// 健康检查路由：GET /api/health
// ----------------------------------------------------------------------------
// 用于部署探活与依赖自检：除服务本身存活外，额外探测 Qdrant 可达性，
// 并回显集合名 / 模型名 / 运行时长，方便运维一眼定位配置。
// ============================================================================

import { qdrant } from '../rag/qdrant.js'
import { config } from '../config.js'

export default async function (app) {
  app.get('/api/health', async () => {
    // 探测 Qdrant：listCollections 成功即认为依赖健康；失败不抛错只标记 false
    let qdrantOk = false
    try {
      await qdrant.getCollections()
      qdrantOk = true
    } catch {}
    return {
      ok: true,                            // 服务自身存活（能响应即 true）
      qdrant: qdrantOk,                    // Qdrant 依赖是否可达
      collection: config.qdrantCollection, // 当前使用的集合名
      llmModel: config.llm.model,          // 当前对话模型
      uptime: Math.round(process.uptime()),// 进程运行秒数
    }
  })
}
