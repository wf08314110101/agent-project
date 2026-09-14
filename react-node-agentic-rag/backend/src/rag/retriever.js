// ============================================================================
// 检索门面：一次"问题 → 相关资料"的粗过滤检索
// ----------------------------------------------------------------------------
// 注意：主 Agent 实际走的是 agent/search-graph.js 的 CRAG 子图（带评估与改写）；
// 本模块是更简单的一步式检索（向量化 → topK → 分数阈值过滤），
// 适合脚本/调试/简单场景复用。
// ============================================================================

import { embedOne } from './embedder.js'
import { search } from './qdrant.js'
import { config } from '../config.js'

/**
 * 检索：query 向量化 → Qdrant 相似度搜索 → 分数阈值粗过滤
 * @param {string}  question - 自然语言问题
 * @param {number}  topK     - 检索条数（默认 5）
 * @returns {Promise<Array>} 过滤后的命中块（score >= retrieveMinScore）
 */
export async function retrieve(question, topK = 5) {
  const vector = await embedOne(question)
  const hits = await search(vector, { limit: topK })
  // 阈值来自 config.retrieveMinScore（默认 0.3）：低分块多为噪声，直接丢弃
  return hits.filter((h) => h.score >= config.retrieveMinScore)
}
