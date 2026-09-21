// ============================================================================
// 领域包注册中心（M17）：内核与领域之间的唯一拼装点
// ----------------------------------------------------------------------------
// 依赖方向：内核(server/tools/ingest) → registry → 领域包；领域包不 import 内核业务层。
// 职责：
//   1. 按 DOMAIN_PACKS env 单激活领域包（默认空 = 纯 core 行为，零破坏面）
//   2. 拼装领域工具表/处理器（tools.js 消费）
//   3. 启动副作用：标签词表注入、切分器注册、提示片段注册、集合 ensure、连接器定时
// 领域包描述符契约（各包 index.js default export）：
//   { name, collection, toolDefs, handlers, promptFragment, tagWhitelist,
//     chunker(text) => [{title,text}], connector?: { run, intervalMs } }
// ============================================================================

import { config } from '../config.js'
import { setTagWhitelist } from '../acl.js'
import { registerChunker } from '../rag/ingest.js'
import { registerPromptFragment } from '../agent/prompts.js'

import apiDocs from './api-docs/index.js'

const ALL_PACKS = [apiDocs]

// 单激活：工具表会进 system prompt，全拼会 token 膨胀且干扰工具选择，故 env 显式指定
const enabled = new Set(
  String(config.domain.packs ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)
export const packs = ALL_PACKS.filter((p) => enabled.has(p.name))
// 激活集合：主检索集合随激活包切换（问答/检索/MCP 的知识源）；空 = core 集合
export const activeCollection = () => packs[0]?.collection ?? config.qdrantCollection
// M20 可写目标集合白名单：core + 已激活领域包集合（上传/写工具共用，防任意集合注入）
export const allowedCollections = () => new Set([config.qdrantCollection, ...packs.map((p) => p.collection)])

export const domainToolDefs = packs.flatMap((p) => p.toolDefs ?? [])
export const domainHandlers = Object.fromEntries(packs.flatMap((p) => Object.entries(p.handlers ?? {})))

let applied = false
/** 启动副作用（server.js 调一次）：词表/切分器/提示片段注入 + 领域集合 ensure + 连接器定时 */
export async function applyDomain(log = console) {
  if (applied) return
  applied = true
  if (!packs.length) {
    log.info?.('[domain] 未启用领域包（DOMAIN_PACKS 为空），纯 core 模式')
    return
  }
  for (const p of packs) {
    setTagWhitelist(p.tagWhitelist)
    if (p.chunker) registerChunker(p.collection, p.chunker)
    registerPromptFragment(p.promptFragment)
    log.info?.(`[domain] 已激活领域包 ${p.name} → 集合 ${p.collection}`)
  }
  // 连接器定时同步（进程内 setInterval；worker 3s 兜底轮询会自然消费 pending 行）
  for (const p of packs) {
    const itv = p.connector?.intervalMs
    if (!p.connector?.run || !itv) continue
    const tick = () =>
      p.connector.run().catch((e) => log.error?.(`[domain:${p.name}] 同步失败: ${e.message}`))
    setTimeout(tick, 15_000).unref?.() // 启动后延迟首跑（等 pg/qdrant 就绪）
    setInterval(tick, itv).unref?.()
    log.info?.(`[domain:${p.name}] 连接器已注册，间隔 ${Math.round(itv / 60_000)} 分钟`)
  }
}
