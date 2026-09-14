import { qdrant } from '../rag/qdrant.js'
import { config } from '../config.js'

export default async function (app) {
  app.get('/api/health', async () => {
    let qdrantOk = false
    try {
      await qdrant.getCollections()
      qdrantOk = true
    } catch {}
    return {
      ok: true,
      qdrant: qdrantOk,
      collection: config.qdrantCollection,
      llmModel: config.llm.model,
      uptime: Math.round(process.uptime()),
    }
  })
}
