// ============================================================================
// 摄取队列：单并发 worker（嵌入是 CPU 密集，避免争抢）
// ----------------------------------------------------------------------------
// 状态流转：pending → processing → ready | failed(error)；卡死 30 分钟的 processing 由 stale 回收重置回 pending
// 职责：事务抢占（FOR UPDATE SKIP LOCKED，多实例安全）最老的 pending 文档 → 解析 → 切块 → 嵌入 → 写入 Qdrant → 更新状态。
// 唤醒机制：worker 常驻循环，"事件唤醒 + 定时兜底轮询"双保险，新文档入队即刻处理。
// ============================================================================

import fs from 'node:fs/promises'
import { parseFile } from './parser.js'
import { chunkText } from './chunker.js'
import { embed } from './embedder.js'
import { ensureCollection, indexChunks } from './qdrant.js'
import { publishDocEvent, ingestBus } from './bus.js'
import {
  setDocStatus,
  setDocChunks,
  claimNextPendingDoc,
  resetProcessing,
  deleteDocRow,
  getUserById,
} from '../store/pg.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ingestBus 由 bus.js 提供（本地订阅端点；多实例时事件经 Redis 广播回流），re-export 供 SSE 路由使用
export { ingestBus }

// 嵌入批大小：CPU 密集，小批多次既保内存可控，又给进度事件提供上报粒度
const EMBED_BATCH = 16

/**
 * 创建摄取 worker（工厂函数，便于在 server.js 与 documents 路由中各自实例化/唤醒）
 * @param {object} log - Fastify 日志实例（可为 null，如路由里创建的临时 worker）
 */
export function createIngestWorker(log) {
  let alive = false        // 循环开关：stop() 置 false 后循环自然退出
  let wakeUp = () => {}    // 唤醒 resolve，由 wake() 调用替换

  // 等待任务：事件唤醒（新文档入队立即处理）与 3s 兜底轮询赛跑
  // 兜底原因：若 wake() 恰好发生在"检查队列与挂起等待之间"的间隙，唤醒信号会丢失
  const waitForWork = () =>
    Promise.race([
      new Promise((r) => { wakeUp = r }), // 新文档入队时立即唤醒
      sleep(3000), // 兜底轮询（防唤醒竞态丢失）
    ])

  /**
   * 处理单个文档的完整摄取流水线：
   * 读原件 → 解析文本 → 切块 → 逐块嵌入 → 确保集合 → 写入 Qdrant → 更新状态
   * 任何一步失败都会把文档标记为 failed(error)，不中断 worker。
   */
  async function processDoc(doc) {
    // 抢占时已置 processing（claimNextPendingDoc），这里仅刷新状态兜底（幂等）
    await setDocStatus('processing', null, doc.id)
    // 进度上报：解析前 5%，解析完 15%，按嵌入批次推进到 90%，入库后 100%（经 Redis 广播到全部实例）
    const report = (status, progress, extra = {}) =>
      publishDocEvent({ id: doc.id, filename: doc.filename, user_id: doc.user_id, status, progress, ...extra })
    report('processing', 5)
    try {
      const buf = await fs.readFile(doc.path)
      const text = await parseFile(doc.filename, buf)
      if (!text?.trim()) throw new Error('解析结果为空') // 扫描版 PDF 等场景

      const chunks = chunkText(text)
      report('processing', 15, { total: chunks.length })
      // 嵌入输入 = 标题 + 正文拼接：标题提供章节上下文，提升向量语义质量
      // 分批嵌入：每批结束上报一次进度（SSE 实时推送），避免长文档全程无反馈
      const vectors = []
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        vectors.push(
          ...await embed(chunks.slice(i, i + EMBED_BATCH).map((c) => (c.title ? `${c.title}\n${c.text}` : c.text)))
        )
        report('processing', Math.min(90, 15 + Math.round(((i + EMBED_BATCH) / Math.max(1, chunks.length)) * 75)))
      }
      await ensureCollection() // 幂等：集合不存在则创建
      // M10 RBAC：密级随块写入 payload（召回前服务端过滤的依据）；ownerDept 从 users 表实时取
      const owner = await getUserById(doc.user_id)
      const n = await indexChunks({
        docId: doc.id,
        filename: doc.filename,
        chunks,
        vectors,
        acl: { ownerId: doc.user_id, classification: doc.classification ?? 'public', ownerDept: owner?.dept ?? '' },
      })

      await setDocChunks(n, doc.id)
      await setDocStatus('ready', null, doc.id)
      await fs.rm(doc.path, { force: true }) // 原件用完即删（省磁盘）
      report('ready', 100, { chunks: n })
      log?.info?.(`[ingest] ${doc.filename} → ready（${n} 块）`)
    } catch (e) {
      // 失败落库：状态 + 错误信息都记录，前端可见原因
      await setDocStatus('failed', e.message, doc.id)
      report('failed', 0, { error: e.message })
      log?.error?.(`[ingest] ${doc.filename} 失败: ${e.message}`)
    }
  }

  // 主循环：有任务就处理（事务抢占，多实例安全），没任务就等待唤醒；alive=false 退出
  async function loop() {
    while (alive) {
      const doc = await claimNextPendingDoc()
      if (!doc) {
        await waitForWork()
        continue
      }
      await processDoc(doc)
    }
  }

  return {
    /** 启动 worker：先回收卡死 30 分钟的 processing 文档（宕机恢复，多实例安全），再进入循环 */
    async start() {
      await resetProcessing() // 宕机恢复
      alive = true
      loop()
      log?.info?.('[ingest] worker 已启动')
    },
    /** 唤醒循环：上传接口入队后调用，让新文档即刻被消费（而非等兜底轮询） */
    wake: () => wakeUp(),
    /** 停止 worker：置开关后立即唤醒，让循环快速走到 while 判断并退出 */
    async stop() {
      alive = false
      wakeUp()
    },
    // 删除失败文档的残留行（前端可点清理）
    async purgeFailed(id) {
      await deleteDocRow(id)
    },
  }
}
