import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline, env } from '@huggingface/transformers'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 模型缓存到 backend/.models，走镜像源下载（国内）
env.cacheDir = path.resolve(__dirname, '../../.models')
env.remoteHost = config.embed.endpoint

let extractor = null

async function getExtractor() {
  if (!extractor) {
    console.log(`[embedder] 加载模型 ${config.embed.model} (host=${env.remoteHost})`)
    extractor = await pipeline('feature-extraction', config.embed.model, {
      device: config.embed.device,
    })
    console.log('[embedder] 模型就绪')
  }
  return extractor
}

// mean pooling + L2 归一化；分批推理防止大文档一次性 OOM
export async function embed(texts, { batchSize = 16 } = {}) {
  const ext = await getExtractor()
  const vectors = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const out = await ext(texts.slice(i, i + batchSize), { pooling: 'mean', normalize: true })
    const dim = out.dims[out.dims.length - 1]
    for (let r = 0; r < out.dims[0]; r++) {
      vectors.push(Array.from(out.data.slice(r * dim, (r + 1) * dim)))
    }
  }
  return vectors
}

export const embedOne = async (text) => (await embed([text]))[0]
