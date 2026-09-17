// ============================================================================
// 嵌入层（ID5 双 provider）：
//   - local  : transformers.js 本地 CPU 推理（缺省，零外部依赖）
//   - openai : OpenAI 兼容 /embeddings 端点（EMBED_PROVIDER=openai，需 EMBED_API_MODEL）
// 公共约定：批量推理 + L2 归一化，输出可直接用于余弦相似度检索。
// ============================================================================

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline, env } from '@huggingface/transformers'
import OpenAI from 'openai'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 模型缓存到 backend/.models，走镜像源下载（国内）
env.cacheDir = path.resolve(__dirname, '../../.models')
env.remoteHost = config.embed.endpoint

let extractor = null // 本地模型单例：进程内只加载一次（加载耗时数秒）
let apiClient = null // 远程嵌入客户端单例

// L2 归一化：远程端点不保证单位模长，cosine 检索统一本地归一化兜底
const l2 = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / n)
}

/** 远程嵌入客户端：baseURL/apiKey 未单独配置时复用 LLM 的 */
async function getApiClient() {
  if (!apiClient) {
    if (!config.embed.apiModel) throw new Error('EMBED_PROVIDER=openai 需配置 EMBED_API_MODEL')
    apiClient = new OpenAI({
      baseURL: config.embed.apiBaseUrl || config.llm.baseUrl,
      apiKey: config.embed.apiKey || config.llm.apiKey,
      timeout: 30_000,
      maxRetries: 2,
    })
    console.log(`[embedder] 远程嵌入 ${config.embed.apiModel} @ ${apiClient.baseURL}`)
  }
  return apiClient
}

/**
 * 懒加载本地嵌入模型单例（provider=local 路径）。
 */
async function getExtractor() {
  if (!extractor) {
    console.log(`[embedder] 加载模型 ${config.embed.model} (host=${env.remoteHost})`)
    extractor = await pipeline('feature-extraction', config.embed.model, {
      device: config.embed.device, // 默认 cpu；transformers.js 也支持 webgpu 等
    })
    console.log('[embedder] 模型就绪')
  }
  return extractor
}

/**
 * 批量向量化：输出与输入顺序一一对应；已归一化（模长为 1）
 * @param {string[]} texts  - 待向量化的文本数组
 * @param {object}   opts
 *   - batchSize: 每批条数（默认 16），批越小内存占用/请求体越小
 * @returns {number[][]} 向量数组
 */
export async function embed(texts, { batchSize = 16 } = {}) {
  if (config.embed.provider === 'openai') {
    const client = await getApiClient()
    const vectors = []
    for (let i = 0; i < texts.length; i += batchSize) {
      const res = await client.embeddings.create({ model: config.embed.apiModel, input: texts.slice(i, i + batchSize) })
      // OpenAI 规范返回顺序与 input 一致；按 index 排序保险
      for (const d of [...res.data].sort((a, b) => a.index - b.index)) {
        vectors.push(l2(Array.from(d.embedding)))
      }
    }
    return vectors
  }
  const ext = await getExtractor()
  const vectors = []
  // 按 batchSize 分批送入模型，避免整篇大文档一次性推理撑爆内存
  for (let i = 0; i < texts.length; i += batchSize) {
    const out = await ext(texts.slice(i, i + batchSize), { pooling: 'mean', normalize: true })
    const dim = out.dims[out.dims.length - 1] // 最后一维即向量维度（如 512）
    // out.data 是扁平的 Float32Array（rows * dim），按行切片还原为向量数组
    for (let r = 0; r < out.dims[0]; r++) {
      vectors.push(Array.from(out.data.slice(r * dim, (r + 1) * dim)))
    }
  }
  return vectors
}

/** 单条向量化便捷封装：检索时用（question → vector） */
export const embedOne = async (text) => (await embed([text]))[0]
