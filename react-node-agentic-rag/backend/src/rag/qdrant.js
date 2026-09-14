import { randomUUID } from 'node:crypto'
import { QdrantClient } from '@qdrant/js-client-rest'
import { config } from '../config.js'

export const qdrant = new QdrantClient({ url: config.qdrantUrl, timeout: 15_000 })

// 建集合：create-and-ignore-409（已存在即幂等成功）
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

const isAlreadyExists = (e) => e?.status === 409 || /already exists/i.test(String(e?.message ?? ''))

export async function indexChunks({ docId, filename, chunks, vectors }) {
  const points = chunks.map((c, i) => ({
    id: randomUUID(),
    vector: vectors[i],
    payload: {
      docId,
      filename,
      title: c.title,
      text: c.text,
      chunkIndex: i,
    },
  }))
  // 1.13+ 客户端：upsert 需用 { points: [...] } 包装
  await qdrant.upsert(config.qdrantCollection, { points }, { wait: true })
  return points.length
}

export async function search(vector, { limit = 5 } = {}) {
  // 1.19 客户端：query() 返回 { points: [...] }
  const { points: hits } = await qdrant.query(config.qdrantCollection, {
    query: vector,
    limit,
    with_payload: true,
  })
  return hits.map((h) => ({ score: h.score, ...h.payload }))
}

export async function deleteDocPoints(docId) {
  await qdrant.delete(config.qdrantCollection, {
    filter: { must: [{ key: 'docId', match: { value: docId } }] },
    wait: true,
  })
}

// 知识库是否为空（用于降级直答预判）
export async function countPoints() {
  const { count } = await qdrant.count(config.qdrantCollection, { exact: true })
  return count
}
