// ============================================================================
// Langfuse 观测封装（可选依赖）：trace / generation / span 的轻量门面
// ----------------------------------------------------------------------------
// 设计要点：
//   1. host + publicKey + secretKey 三项齐全才启用，缺任一则为 null；
//   2. 未启用时 startTrace 返回"空壳对象"（同名方法的 no-op），
//      业务代码无需到处判空，直接链式调用 startTrace().generation().end()；
//   3. flushAt=1 让每条记录立即入队上报，requestTimeout=10s 防挂起。
// ============================================================================

import { Langfuse } from 'langfuse'
import { config } from '../config.js'

// 三项配置都非空才视为启用
const enabled = !!(config.langfuse.host && config.langfuse.publicKey && config.langfuse.secretKey)

export const langfuse = enabled
  ? new Langfuse({ ...config.langfuse, flushAt: 1, requestTimeout: 10_000 })
  : null
export const langfuseEnabled = enabled

/**
 * 空壳对象：与真实 trace 同接口的 no-op
 * generation/span 递归返回自身（shell），因此可以任意深度链式调用而不报错
 */
const shell = () => ({ generation: shell, span: shell, update: () => {}, end: () => {}, id: null })

/**
 * 开启一条 trace（一次问答 = 一条 trace）
 * 未启用时返回空壳，业务代码免判空
 * @returns {object} Langfuse trace 或 no-op 空壳（均有 generation/span/update/end）
 */
export function startTrace({ name, input, metadata } = {}) {
  if (!langfuse) return shell()
  return langfuse.trace({ name, input, metadata })
}

/**
 * 冲刷待上报队列（异步、吞错）：chat 请求 finally 中调用，
 * 保证进程不因 Langfuse 上报失败而受影响。
 */
export const flushObs = () => langfuse?.flushAsync?.().catch(() => {})
