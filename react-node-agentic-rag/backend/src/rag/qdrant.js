// ============================================================================
// Qdrant 向量库封装：集合管理 / 索引写入 / 相似度检索 / 删除 / 计数
// ----------------------------------------------------------------------------
// payload 约定：每个 point 携带 { docId, filename, title, text, chunkIndex }，
// docId 用于按文档级联删除向量；docId:chunkIndex 用于检索结果去重定位。
// 版本注意：客户端 1.13+ upsert 参数需 { points: [...] } 包装；1.19+ query() 返回 { points }。
// ============================================================================

import { randomUUID } from 'node:crypto'
import { QdrantClient } from '@qdrant/js-client-rest'
import { config } from '../config.js'

// 共享客户端实例：15s 超时防止 Qdrant 卡死拖垮请求
export const qdrant = new QdrantClient({ url: config.qdrantUrl, timeout: 15_000 })

/**
 * 幂等创建集合：向量维度取 config.embed.dim，距离用 Cosine
 * （嵌入向量已 L2 归一化，Cosine 等价于内积，是最常用的语义检索距离）
 * 已存在（409）视为成功；其他错误向上抛出。
 */
export async function ensureCollection() {
  try {
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: { size: config.embed.dim, distance: 'Cosine' },
    })
    console.log(`[qdrant] 已创建集合 ${config.qdrantCollection}`)
  } catch (e) {
    if (!isAlreadyExists(e)) throw e
    console.log(`[qdrant] 集合 ${config.qdrantCollection} 已存在，跳过创建`)
  }
}

// 判断"集合已存在"错误：兼容 HTTP 409 状态码与错误消息两种形态
const isAlreadyExists = (e) => e?.status === 409 || /already exists/i.test(String(e?.message ?? ''))

/**
 * 批量写入向量点：每块生成一个随机 UUID point，payload 记录溯源信息
 * @returns {number} 写入的点数
 */
export async function indexChunks({ docId, filename, chunks, vectors }) {
  const points = chunks.map((c, i) => ({
    id: randomUUID(), // point id 必须是 UUID 或整数，用随机 UUID 避免冲突
    vector: vectors[i],
    payload: {
      docId,      // 所属文档（级联删除键）
      filename,   // 原始文件名（展示）
      title: c.title,     // 所属章节标题（块上下文）
      text: c.text,       // 块正文
      chunkIndex: i,      // 块序号（去重 key 的一部分）
    },
  }))
  // 1.13+ 客户端：upsert 需用 { points: [...] } 包装；wait:true 确保写入可见再继续
  await qdrant.upsert(config.qdrantCollection, { points }, { wait: true })
  return points.length
}

/**
 * 相似度检索：向量 → 最近邻 K 条
 * @param {number[]} vector - 查询向量（已归一化）
 * @param {object} opts.limit - 返回条数（默认 5）
 * @returns {Array<{score: number, docId, filename, title, text, chunkIndex}>} 分数降序
 */
export async function search(vector, { limit = 5 } = {}) {
  // 1.19 客户端：query() 返回 { points: [...] }
  const { points: hits } = await qdrant.query(config.qdrantCollection, {
    query: vector,
    limit,
    with_payload: true, // 命中必须带 payload 才能拼装引用
  })
  // 把 payload 摊平到结果对象，score 放最前
  return hits.map((h) => ({ score: h.score, ...h.payload }))
}

/**
 * 按文档删除全部向量点：删除文档时调用（先删向量，再删元数据）
 * filter 过滤器等价于 SQL 的 WHERE docId = ?
 */
export async function deleteDocPoints(docId) {
  await qdrant.delete(config.qdrantCollection, {
    filter: { must: [{ key: 'docId', match: { value: docId } }] },
    wait: true,
  })
}

/**
 * 统计集合内点数（精确计数）：用于判断知识库是否为空，
 * chat 路由据此做降级预判（空库直接让 LLM 直答，省掉无意义的检索轮）。
 */
export async function countPoints() {
  const { count } = await qdrant.count(config.qdrantCollection, { exact: true })
  return count
}
