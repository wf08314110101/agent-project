// ============================================================================
// 长会话记忆压缩（M4）：窗口外历史不丢弃，滚动压缩为一条会话级摘要
// ----------------------------------------------------------------------------
// 定位模型（seq 水位断点，删除免疫）：
//   summarized_seq = 已压缩的最大 seq（断点）
//   窗口起点 ws    = 最近 windowSize 条里最早一条的 seq
//   待压缩区       = (summarized_seq, ws]，攒够 COMPRESS_BATCH 条触发一次增量压缩
//   上下文回放     = seq > 断点的全部消息（= 固定窗口 + 未压缩真空区，零丢失，
//                     上界 windowSize + COMPRESS_BATCH - 1 条）
// 增量压缩：旧摘要 + 新出窗 → 新摘要；断点推进到 ws；失败退化为仅回放窗口。
// ============================================================================

import { windowStartSeq, countPending, listPending, getMemory, updateMemory } from '../store/pg.js'
import { chatStream } from '../llm.js'
import { config } from '../config.js'
import { memoryMessages } from './prompts.js'
import { otelSpan } from '../obs/otel.js'

const COMPRESS_BATCH = 10 // 每攒够多少条出窗消息触发一次增量压缩（摊薄成本）

/**
 * 压缩窗口外历史，返回注入上下文的记忆文本（无摘要时返回 null）
 * @param {object} p
 * @param {string}   p.sessionId - 会话 ID
 * @param {Function} p.emit      - SSE 发射器（压缩发生时推 step 事件给前端）
 * @param {Array}    p.usageAcc  - usage 累积器（摘要调用也计入总账）
 * @param {AbortSignal} p.signal - 客户端断开时中断
 */
export async function compressMemory({ sessionId, emit, usageAcc, signal }) {
  const { windowSize } = config.memory
  const ws = (await windowStartSeq(sessionId, windowSize)).s
  if (!ws) return null // 不足一窗，无需压缩

  const mem = (await getMemory(sessionId)) ?? { summary: '', summarized_seq: 0 }
  const pending = (await countPending(sessionId, mem.summarized_seq ?? 0, ws)).n
  if (pending < COMPRESS_BATCH) return mem.summary || null // 攒批：不够 10 条先复用旧摘要

  const span = otelSpan('memory.compress', 'CHAIN', { 'input.value': `旧摘要${mem.summary ? 1 : 0} + 出窗${pending}条` })
  // 取未压缩的出窗消息（断点 → 窗口起点]，连同旧摘要一起送 LLM 增量压缩
  const olds = await listPending(sessionId, mem.summarized_seq ?? 0, ws)
  const { message, usage } = await chatStream(memoryMessages(mem.summary ?? '', olds), { signal })
  usageAcc?.push(usage)
  const summary = (message.content ?? '').trim()
  if (!summary) throw new Error('记忆压缩返回空摘要')
  span.end(summary.slice(0, 500), { usage })

  // 断点推进到窗口起点：ws 之前的消息全部视为已压缩（seq 水位，删除不回移）
  await updateMemory(summary, ws, sessionId)
  emit?.('step', {
    phase: 'thought',
    label: '历史压缩',
    content: `已将 ${pending} 条早期对话压缩为会话记忆（断点推进到 #${ws}）`,
  })
  return summary
}

/** 压缩失败的兜底：返回旧摘要（可能为 null），保证对话不因记忆系统故障而中断 */
export const memoryFallback = async (sessionId) => {
  try {
    return (await getMemory(sessionId))?.summary || null
  } catch {
    return null
  }
}
