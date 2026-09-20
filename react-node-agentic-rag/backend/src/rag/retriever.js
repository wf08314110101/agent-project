// ============================================================================
// 检索门面：一次"问题 → 相关资料"的粗过滤检索
// ----------------------------------------------------------------------------
// 注意：主 Agent 实际走的是 agent/search-graph.js 的 CRAG 子图（带评估与改写）；
// 本模块是更简单的一步式检索（向量化 → topK → 分数阈值过滤），
// 适合脚本/调试/简单场景复用。
// ============================================================================

import { embedOne } from './embedder.js'
import { hybridSearch } from './qdrant.js'
import { activeCollection } from '../domain/registry.js'

/**
 * 检索：query 向量化 → Qdrant 混合检索（稠密语义 + 稀疏关键词 RRF 融合）
 * @param {string}  question - 自然语言问题
 * @param {number}  topK     - 检索条数（默认 5）
 * @param {string}  [docId]  - 指定文档过滤（调试口/评估用），空则检索全库
 * @param {object|null} [acl]- M10 RBAC 过滤（aclFor 产物），缺省不过滤
 * @returns {Promise<Array>} 命中块（阈值已在稠密路 prefetch 服务端应用；
 *          融合分为排名分，不再二次过滤）
 */
export async function retrieve(question, topK = 5, docId, acl, collection) {
  const vector = await embedOne(question)
  // M17 定向集合：docId 观测时调用方传文档所属集合；缺省走激活集合
  const { hits } = await hybridSearch({ text: question, vector, limit: topK, docId, acl, collection: collection ?? activeCollection() })
  return hits
}
