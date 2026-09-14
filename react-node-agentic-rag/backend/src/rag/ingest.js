// 摄取队列：单并发 worker（嵌入是 CPU 密集，避免争抢）
// 状态流转：pending → processing → ready | failed(error)；重启时 processing 重置回 pending
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

export function createIngestWorker(log) {
  let alive = false
  let wakeUp = () => {}

  const waitForWork = () =>
    Promise.race([
      new Promise((r) => { wakeUp = r }), // 新文档入队时立即唤醒
      sleep(3000), // 兜底轮询（防唤醒竞态丢失）
    ])

  async function processDoc(doc) {
    setDocStatus.run('processing', null, doc.id)
    try {
      const buf = await fs.readFile(doc.path)
      const text = await parseFile(doc.filename, buf)
      if (!text?.trim()) throw new Error('解析结果为空')

      const chunks = chunkText(text)
      const vectors = await embed(chunks.map((c) => (c.title ? `${c.title}\n${c.text}` : c.text)))
      await ensureCollection()
      const n = await indexChunks({ docId: doc.id, filename: doc.filename, chunks, vectors })

      setDocChunks.run(n, doc.id)
      setDocStatus.run('ready', null, doc.id)
      await fs.rm(doc.path, { force: true }) // 原件用完即删（省磁盘）
      log?.info?.(`[ingest] ${doc.filename} → ready（${n} 块）`)
    } catch (e) {
      setDocStatus.run('failed', e.message, doc.id)
      log?.error?.(`[ingest] ${doc.filename} 失败: ${e.message}`)
    }
  }

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
    start() {
      resetProcessing.run() // 宕机恢复
      alive = true
      loop()
      log?.info?.('[ingest] worker 已启动')
    },
    wake: () => wakeUp(),
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
