// ============================================================================
// 检索门面：一次"问题 → 相关资料"的粗过滤检索
// ----------------------------------------------------------------------------
// 注意：主 Agent 实际走的是 agent/search-graph.js 的 CRAG 子图（带评估与改写）；
// 本模块是更简单的一步式检索（向量化 → topK → 分数阈值过滤），
// 适合脚本/调试/简单场景复用。
// ============================================================================

import { embedOne } from './embedder.js'
import { hybridSearch } from './qdrant.js'

/**
 * 检索：query 向量化 → Qdrant 混合检索（稠密语义 + 稀疏关键词 RRF 融合）
 * @param {string}  question - 自然语言问题
 * @param {number}  topK     - 检索条数（默认 5）
 * @returns {Promise<Array>} 命中块（阈值已在稠密路 prefetch 服务端应用；
 *          融合分为排名分，不再二次过滤）
 */
export async function retrieve(question, topK = 5) {
  const vector = await embedOne(question)
  const { hits } = await hybridSearch({ text: question, vector, limit: topK })
  return hits
}
