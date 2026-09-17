// ============================================================================
// Cross-Encoder 客户端 rerank（M9）：bge-reranker-base（q8 ONNX，本地 CPU）
// ----------------------------------------------------------------------------
// 背景（M8 实验结论）：Qdrant 服务端策略（dbsf/池扩/dense rescore）对语料级歧义
// 无解——cross-encoder 把 (query, doc) 拼接后联合编码，才能区分「讲检索模式的
// 干扰块」与「真正回答检索模式的块」。
// 排序键 = 原始 logit（sigmoid 前的 relevance 分，单调可排序）。
// 懒加载单例；分批推理防长文本 OOM；tokenizer 显式 max_length=512 截断
// （ONNX 转换常丢失 model_max_length 元数据，不显式传会被超长文本撑爆）。
// ============================================================================

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { AutoTokenizer, AutoModelForSequenceClassification, env } from '@huggingface/transformers'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
env.cacheDir = path.resolve(__dirname, '../../.models') // 与嵌入模型共用缓存目录
env.remoteHost = config.embed.endpoint // hf-mirror（国内）

let reranker = null // 懒加载单例 { tok, model }（首次调用加载数秒，此后复用）

async function getReranker() {
  if (!reranker) {
    console.log(`[reranker] 加载 cross-encoder ${config.rerank.model} (${config.rerank.dtype})`)
    const tok = await AutoTokenizer.from_pretrained(config.rerank.model)
    const model = await AutoModelForSequenceClassification.from_pretrained(config.rerank.model, {
      dtype: config.rerank.dtype,
    })
    reranker = { tok, model }
    console.log('[reranker] 就绪')
  }
  return reranker
}

// ---- rerank 分数缓存（ID7）：键 = sha1(查询 + 有序块文本哈希)，内容寻址天然免疫脏读 ----
// 命中等价重放 rerankScore（省 CPU cross-encoder 推理）；重启即空，纯优化层
const scoreCache = new Map()
const SCORE_CACHE_MAX = 300
const textHash = (t) => createHash('sha1').update(t).digest('hex')

/**
 * 重排：对 (query, hit) 逐对打 relevance 分（raw logit），降序取前 topK
 * @param {string}  query   - 查询原文
 * @param {Array}   hits    - 候选块（召回池，如混合检索 limit=20 的结果）
 * @param {object}  opts
 *   - topK:  返回条数（默认全部，保持原顺序语义由调用方截断）
 *   - textOf: 块文本提取（默认 h.text；可拼接标题等上下文）
 * @returns {Promise<Array>} 重排后命中（附 rerankScore = 原始 logit）；返回克隆，调用方可安全改写
 */
export async function rerank(query, hits, { topK = hits.length, textOf = (h) => h.text } = {}) {
  if (!hits.length) return []
  const cacheKey = createHash('sha1')
    .update(query.trim().toLowerCase() + '\n' + hits.map((h) => textHash(textOf(h))).join(','))
    .digest('hex')
  const hit = scoreCache.get(cacheKey)
  if (hit) return hit.slice(0, topK).map((h) => ({ ...h })) // 克隆防调用方改写污染缓存
  const { tok, model } = await getReranker()
  const texts = hits.map(textOf)
  const scored = []
  const BATCH = 8 // CPU 分批：批越大吞吐越高，内存峰值越大
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH)
    const inputs = tok(Array(chunk.length).fill(query), {
      text_pair: chunk,
      padding: true,
      truncation: true,
      max_length: 512,
    })
    const { logits } = await model(inputs) // [batch, 1] 原始 logit
    for (let j = 0; j < chunk.length; j++) {
      scored.push({ ...hits[i + j], rerankScore: logits.data[j] })
    }
  }
  const sorted = scored.sort((a, b) => b.rerankScore - a.rerankScore)
  scoreCache.set(cacheKey, sorted)
  if (scoreCache.size > SCORE_CACHE_MAX) scoreCache.delete(scoreCache.keys().next().value) // FIFO
  return sorted.slice(0, topK).map((h) => ({ ...h }))
}
