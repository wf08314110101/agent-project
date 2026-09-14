import { Langfuse } from 'langfuse'
import { config } from '../config.js'

const enabled = !!(config.langfuse.host && config.langfuse.publicKey && config.langfuse.secretKey)

export const langfuse = enabled
  ? new Langfuse({ ...config.langfuse, flushAt: 1, requestTimeout: 10_000 })
  : null
export const langfuseEnabled = enabled

const shell = () => ({ generation: shell, span: shell, update: () => {}, end: () => {}, id: null })

// 未启用时返回空壳，业务代码免判空
export function startTrace({ name, input, metadata } = {}) {
  if (!langfuse) return shell()
  return langfuse.trace({ name, input, metadata })
}

export const flushObs = () => langfuse?.flushAsync?.().catch(() => {})
