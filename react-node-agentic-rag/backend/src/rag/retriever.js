import { embedOne } from './embedder.js'
import { search } from './qdrant.js'
import { config } from '../config.js'

// 检索：query 向量化 → Qdrant 相似度搜索 → 分数阈值粗过滤
export async function retrieve(question, topK = 5) {
  const vector = await embedOne(question)
  const hits = await search(vector, { limit: topK })
  return hits.filter((h) => h.score >= config.retrieveMinScore)
}
