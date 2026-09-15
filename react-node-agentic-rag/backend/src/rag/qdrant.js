// ============================================================================
// Qdrant 向量库封装：集合管理 / 索引写入 / 混合检索 / 删除 / 计数
// ----------------------------------------------------------------------------
// payload 约定：每个 point 携带 { docId, filename, title, text, chunkIndex }，
// docId 用于按文档级联删除向量；docId:chunkIndex 用于检索结果去重定位。
// 混合检索（M4）：每个 point 双向量 ——
//   dense  : bge-small-zh 稠密语义向量（Cosine）
//   sparse : jieba 分词词频向量（服务端 IDF 加权，BM25 语义）
// 查询：prefetch 双路召回 → 服务端 RRF 倒数排名融合，一次往返。
// 版本注意：客户端 1.13+ upsert 参数需 { points: [...] } 包装；1.19+ query() 返回 { points }。
// ============================================================================

import { randomUUID } from 'node:crypto'
import { QdrantClient } from '@qdrant/js-client-rest'
import { config } from '../config.js'
import { toSparse } from './tokenizer.js'

// 共享客户端实例：15s 超时防止 Qdrant 卡死拖垮请求
export const qdrant = new QdrantClient({ url: config.qdrantUrl, timeout: 15_000 })

// 稀疏路召回上限：RRF 只看排名不看绝对分，双路各多召回一些再融合，最后截 topK
const prefetchLimit = (k) => Math.max(k * 3, 12)

/**
 * 幂等创建集合：稠密向量（config.embed.dim，Cosine）+ 稀疏向量（IDF modifier）。
 * 旧集合只有默认无名稠密向量、无稀疏索引——检测到则删除重建（向量可由文档重新摄取恢复，
 * 属一次性迁移，日志明示）。
 */
export async function ensureCollection() {
  try {
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: { dense: { size: config.embed.dim, distance: 'Cosine' } },
      sparse_vectors: { sparse: { modifier: 'idf' } },
    })
    console.log(`[qdrant] 已创建混合检索集合 ${config.qdrantCollection}（dense + sparse/idf）`)
    return
  } catch (e) {
    if (!isAlreadyExists(e)) throw e
  }
  // 已存在：检查是否有稀疏索引，没有（M4 之前的旧集合）则重建
  const info = await qdrant.getCollection(config.qdrantCollection)
  if (!info?.config?.params?.sparse_vectors) {
    console.warn(`[qdrant] 旧集合无稀疏索引，删除重建（已存文档需重新上传摄取）`)
    await qdrant.deleteCollection(config.qdrantCollection)
    await ensureCollection()
    return
  }
  console.log(`[qdrant] 集合 ${config.qdrantCollection} 已存在，跳过创建`)
}

// 判断"集合已存在"错误：兼容 HTTP 409 状态码与错误消息两种形态
const isAlreadyExists = (e) => e?.status === 409 || /already exists/i.test(String(e?.message ?? ''))

/**
 * 批量写入向量点：每块一个随机 UUID point；向量 = { dense, sparse } 双路，
 * sparse 的输入与稠密嵌入一致（标题+正文拼接），保证两路看的是同一段内容
 */
export async function indexChunks({ docId, filename, chunks, vectors }) {
  const points = chunks.map((c, i) => {
    const text = c.title ? `${c.title}\n${c.text}` : c.text
    return {
      id: randomUUID(), // point id 必须是 UUID 或整数，用随机 UUID 避免冲突
      vector: { dense: vectors[i], sparse: toSparse(text) },
      payload: {
        docId,      // 所属文档（级联删除键）
        filename,   // 原始文件名（展示）
        title: c.title,     // 所属章节标题（块上下文）
        text: c.text,       // 块正文
        chunkIndex: i,      // 块序号（去重 key 的一部分）
      },
    }
  })
  // 1.13+ 客户端：upsert 需用 { points: [...] } 包装；wait:true 确保写入可见再继续
  await qdrant.upsert(config.qdrantCollection, { points }, { wait: true })
  return points.length
}

/**
 * 混合检索：稠密语义路 + 稀疏关键词路 → 服务端 RRF 融合
 * @param {object}   p
 * @param {string}   p.text    - 查询原文（分词构建稀疏向量）
 * @param {number[]} p.vector  - 查询稠密向量（已归一化）
 * @param {number}   p.limit   - 返回条数（默认 5）
 * @returns {Promise<{hits: Array, mode: string}>} 融合后 topK；
 *          mode = 'hybrid-rrf' | 'dense-fallback'（稀疏路故障时退化，阈值语义回到余弦分）
 */
export async function hybridSearch({ text, vector, limit = 5 }) {
  const k = prefetchLimit(limit)
  try {
    const { points: hits } = await qdrant.query(config.qdrantCollection, {
      prefetch: [
        // 稠密路：语义相似；阈值粗滤在服务端做（余弦分量纲，仅此路有效）
        { query: vector, using: 'dense', limit: k, threshold: config.retrieveMinScore },
        // 稀疏路：字面/BM25 匹配，无需阈值（BM25 分数量纲与余弦无关）
        { query: toSparse(text), using: 'sparse', limit: k },
      ],
      query: { fusion: 'rrf' }, // 倒数排名融合：score = Σ 1/(60+rank)，只代表融合排名
      limit,
      with_payload: true, // 命中必须带 payload 才能拼装引用
    })
    return { mode: 'hybrid-rrf', hits: hits.map((h) => ({ score: h.score, ...h.payload })) }
  } catch (e) {
    // 稀疏路不可用（旧集合/服务端不支持）：退化为纯稠密检索，保持可用性
    console.warn(`[qdrant] 混合检索失败，退化纯稠密: ${e.message}`)
    const { points: hits } = await qdrant.query(config.qdrantCollection, {
      query: vector,
      limit,
      with_payload: true,
    })
    return {
      mode: 'dense-fallback',
      hits: hits.filter((h) => h.score >= config.retrieveMinScore).map((h) => ({ score: h.score, ...h.payload })),
    }
  }
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
