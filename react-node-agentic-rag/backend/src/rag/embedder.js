// ============================================================================
// 嵌入层：基于 transformers.js 在本地 CPU 上运行中文嵌入模型
// ----------------------------------------------------------------------------
// - 模型懒加载（首次调用时才加载，加载结果缓存复用）；
// - 模型文件缓存到 backend/.models，通过 HF 镜像源下载（国内网络友好）；
// - 批量推理 + mean pooling + L2 归一化，输出可直接用于余弦相似度检索。
// ============================================================================

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline, env } from '@huggingface/transformers'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 模型缓存到 backend/.models，走镜像源下载（国内）
env.cacheDir = path.resolve(__dirname, '../../.models')
env.remoteHost = config.embed.endpoint

let extractor = null // 模块级单例：进程内只加载一次模型（加载耗时数秒）

/**
 * 懒加载嵌入模型单例。
 * 首次调用时下载（或读取缓存）并初始化 pipeline，之后直接复用。
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
 * 批量向量化：mean pooling + L2 归一化；分批推理防止大文档一次性 OOM
 * @param {string[]} texts  - 待向量化的文本数组
 * @param {object}   opts
 *   - batchSize: 每批条数（默认 16），批越小内存占用越低
 * @returns {number[][]} 向量数组，与输入顺序一一对应；已归一化（模长为 1）
 */
export async function embed(texts, { batchSize = 16 } = {}) {
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
