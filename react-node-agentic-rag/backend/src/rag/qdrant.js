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

// 稀疏路召回上限：融合只看排名/分数，双路各多召回一些再融合，最后截 topK
// mul 为实验参数（RETRIEVE_PREFETCH_MUL），0 = 默认策略 max(k*3, 12)
const prefetchLimit = (k, mul) => (mul ? k * mul : Math.max(k * 3, 12))

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
  // M10 RBAC 存量回填：旧点位无 classification payload → 补 public
  // （升级前文档全局可读，保持原可见性；否则 ACL 过滤会把旧文档全部滤掉）
  try {
    await qdrant.setPayload(config.qdrantCollection, {
      payload: { classification: 'public' },
      filter: { must: [{ is_empty: { key: 'classification' } }] },
    })
  } catch (e) {
    console.warn(`[qdrant] ACL payload 存量回填失败: ${e.message}`)
  }
  console.log(`[qdrant] 集合 ${config.qdrantCollection} 已存在，跳过创建`)
}

// 判断"集合已存在"错误：兼容 HTTP 409 状态码与错误消息两种形态
const isAlreadyExists = (e) => e?.status === 409 || /already exists/i.test(String(e?.message ?? ''))

/**
 * 批量写入向量点：每块一个随机 UUID point；向量 = { dense, sparse } 双路，
 * sparse 的输入与稠密嵌入一致（标题+正文拼接），保证两路看的是同一段内容。
 * acl：RBAC 随行元数据（ownerId/classification/ownerDept），写入每块 payload 供召回前过滤
 */
export async function indexChunks({ docId, filename, chunks, vectors, acl = {} }) {
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
        ownerId: acl.ownerId ?? '',              // M10 RBAC：归属人
        classification: acl.classification ?? 'public', // 密级：public/dept/private
        ownerDept: acl.ownerDept ?? '',          // 归属人部门（dept 密级过滤键）
      },
    }
  })
  // 1.13+ 客户端：upsert 需用 { points: [...] } 包装；wait:true 确保写入可见再继续
  await qdrant.upsert(config.qdrantCollection, { points }, { wait: true })
  invalidateCount() // 点数变化：空库降级预判的计数缓存立即失效
  return points.length
}

/**
 * 混合检索：稠密语义路 + 稀疏关键词路 → 服务端融合
 * @param {object}   p
 * @param {string}   p.text    - 查询原文（分词构建稀疏向量）
 * @param {number[]} p.vector  - 查询稠密向量（已归一化）
 * @param {number}   p.limit   - 返回条数（默认 5）
 * @param {string}   [p.docId] - 指定文档过滤（「对此文档提问」），空则检索全库
 * @param {'rrf'|'dbsf'} [p.fusion]     - 融合算法（M8 实验：rrf 排名融合 / dbsf 绝对分融合）
 * @param {number}   [p.prefetchMul]    - 召回池倍率（0/缺省 = 默认 max(k*3,12)）
 * @param {'none'|'dense'} [p.rerank]   - dense rescore：召回池并集按稠密语义分精排
 * @param {object|null} [p.acl] - M10 RBAC 过滤：{ userId, role, dept, grants?: string[] }；
 *        null/缺省 = 不过滤（脚本/评估直连）；admin 跳过过滤；member 按密级 + 授权过滤
 * @returns {Promise<{hits: Array, mode: string}>} 融合后 topK；
 *          mode = 'hybrid-rrf' | 'hybrid-dbsf' | 'hybrid-rrf+dense' | 'dense-fallback'
 */
export async function hybridSearch({ text, vector, limit = 5, docId, acl, fusion = config.retrieveFusion, prefetchMul = 0, rerank = 'none' }) {
  const k = prefetchLimit(limit, prefetchMul)
  // M10 ACL：密级下沉为召回前服务端过滤（payload: classification/ownerId/ownerDept）
  // 可读条件（should 组，至少命中其一）：public ∪ 本人所有 ∪ 同部门 dept ∪ 显式授权 docId
  const aclCond = acl && acl.role !== 'admin'
    ? {
        should: [
          { key: 'classification', match: { value: 'public' } },
          { key: 'ownerId', match: { value: acl.userId } },
          ...(acl.dept
            ? [{ must: [{ key: 'classification', match: { value: 'dept' } }, { key: 'ownerDept', match: { value: acl.dept } }] }]
            : []),
          ...(acl.grants?.length ? [{ key: 'docId', match: { any: acl.grants } }] : []),
        ],
      }
    : {}
  // docId 范围过滤：挂顶层 filter（融合后生效），两路 prefetch 天然都被约束；
  // must（docId 范围）与 should（ACL 可读性）同层 = AND 语义，两层同时生效
  const scope = {
    filter: {
      ...(docId ? { must: [{ key: 'docId', match: { value: docId } }] } : {}),
      ...aclCond,
    },
  }
  const sparseVec = toSparse(text)
  const fetch2 = [
    // 稠密路：语义相似；阈值粗滤在服务端做（余弦分量纲，仅此路有效）
    { query: vector, using: 'dense', limit: k, threshold: config.retrieveMinScore },
    // 稀疏路：字面/BM25 匹配，无需阈值（BM25 分数量纲与余弦无关）
    { query: sparseVec, using: 'sparse', limit: k },
  ]
  // 外层 query：默认按融合算法合并；dense rescore 模式改为在「dense ∪ sparse ∪ RRF 前列」
  // 三路并集上按稠密语义分精排——验证"字面召回池 + 语义精排"对字面强命中的歧义题的效果
  const params = rerank === 'dense'
    ? {
        prefetch: [...fetch2, { prefetch: fetch2, query: { fusion: 'rrf' }, limit: k }],
        query: vector,
        using: 'dense',
        limit,
        with_payload: true,
        ...scope,
      }
    : {
        prefetch: fetch2,
        query: { fusion },
        limit,
        with_payload: true,
        ...scope,
      }
  try {
    const { points: hits } = await qdrant.query(config.qdrantCollection, params)
    return {
      mode: rerank === 'dense' ? 'hybrid-rrf+dense' : `hybrid-${fusion}`,
      hits: hits.map((h) => ({ score: h.score, ...h.payload })),
    }
  } catch (e) {
    // 稀疏路不可用（旧集合/服务端不支持）：退化为纯稠密检索，保持可用性
    console.warn(`[qdrant] 混合检索失败，退化纯稠密: ${e?.data?.status?.error ?? e.message}`)
    const { points: hits } = await qdrant.query(config.qdrantCollection, {
      query: vector,
      using: 'dense', // 集合为命名向量，必须显式指定（缺省默认空名会 400）
      limit,
      with_payload: true,
      ...scope,
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
  invalidateCount() // 点数变化：空库降级预判的计数缓存立即失效
}

/**
 * 同步文档级 ACL payload（M10）：PATCH 密级后把新值刷到该文档所有块的 payload，
 * 保证「改密级 → 检索立即生效」，无需重新摄取
 */
export async function setDocAclPayload(docId, { ownerId, classification, ownerDept }) {
  await qdrant.setPayload(config.qdrantCollection, {
    payload: { ownerId: ownerId ?? '', classification: classification ?? 'public', ownerDept: ownerDept ?? '' },
    filter: { must: [{ key: 'docId', match: { value: docId } }] },
    wait: true,
  })
}

/**
 * 统计集合内点数（精确计数 + 30s TTL 缓存）：用于判断知识库是否为空，
 * chat 路由据此做降级预判（空库直接让 LLM 直答，省掉无意义的检索轮）。
 * 缓存是纯优化层：每次问答省一次 Qdrant 往返；写操作（入库/删向量）立即失效，
 * 保证"空库判断"在摄取完成后最多延迟 TTL 秒收敛。
 */
let countCache = { v: null, at: 0 }
const COUNT_TTL_MS = 30_000
const invalidateCount = () => { countCache = { v: null, at: 0 } }

export async function countPoints() {
  if (countCache.v !== null && Date.now() - countCache.at < COUNT_TTL_MS) return countCache.v
  const { count } = await qdrant.count(config.qdrantCollection, { exact: true })
  countCache = { v: count, at: Date.now() }
  return count
}
