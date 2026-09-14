// ============================================================================
// 摄取队列：单并发 worker（嵌入是 CPU 密集，避免争抢）
// ----------------------------------------------------------------------------
// 状态流转：pending → processing → ready | failed(error)；重启时 processing 重置回 pending
// 职责：从 SQLite 取最老的 pending 文档 → 解析 → 切块 → 嵌入 → 写入 Qdrant → 更新状态。
// 唤醒机制：worker 常驻循环，"事件唤醒 + 定时兜底轮询"双保险，新文档入队即刻处理。
// ============================================================================

import fs from 'node:fs/promises'
import { parseFile } from './parser.js'
import { chunkText } from './chunker.js'
import { embed } from './embedder.js'
import { ensureCollection, indexChunks } from './qdrant.js'
import {
  setDocStatus,
  setDocChunks,
  nextPendingDoc,
  resetProcessing,
  deleteDocRow,
} from '../store/sqlite.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    setDocStatus.run('processing', null, doc.id) // 先占坑，防止重复消费
    try {
      const buf = await fs.readFile(doc.path)
      const text = await parseFile(doc.filename, buf)
      if (!text?.trim()) throw new Error('解析结果为空') // 扫描版 PDF 等场景

      const chunks = chunkText(text)
      // 嵌入输入 = 标题 + 正文拼接：标题提供章节上下文，提升向量语义质量
      const vectors = await embed(chunks.map((c) => (c.title ? `${c.title}\n${c.text}` : c.text)))
      await ensureCollection() // 幂等：集合不存在则创建
      const n = await indexChunks({ docId: doc.id, filename: doc.filename, chunks, vectors })

      setDocChunks.run(n, doc.id)
      setDocStatus.run('ready', null, doc.id)
      await fs.rm(doc.path, { force: true }) // 原件用完即删（省磁盘）
      log?.info?.(`[ingest] ${doc.filename} → ready（${n} 块）`)
    } catch (e) {
      // 失败落库：状态 + 错误信息都记录，前端可见原因
      setDocStatus.run('failed', e.message, doc.id)
      log?.error?.(`[ingest] ${doc.filename} 失败: ${e.message}`)
    }
  }

  // 主循环：有任务就处理，没任务就等待唤醒；alive=false 退出
  async function loop() {
    while (alive) {
      const doc = nextPendingDoc.get()
      if (!doc) {
        await waitForWork()
        continue
      }
      await processDoc(doc)
    }
  }

  return {
    /** 启动 worker：先把卡在 processing 的文档重置回 pending（宕机恢复），再进入循环 */
    start() {
      resetProcessing.run() // 宕机恢复
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
      deleteDocRow.run(id)
    },
  }
}
