import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ACCEPT_EXT, hashBuffer } from '../rag/parser.js'
import { createIngestWorker } from '../rag/ingest.js'
import { insertDoc, listDocs, getDoc, getDocByHash, deleteDocRow } from '../store/sqlite.js'
import { deleteDocPoints } from '../rag/qdrant.js'
import { config } from '../config.js'

export default async function (app) {
  const worker = createIngestWorker(app.log)

  // M3 异步摄取：校验+去重+落盘入队即返回 202，解析/切块/嵌入由 worker 后台做，前端轮询状态
  app.post('/api/documents', async (req, reply) => {
    try {
      const file = await req.file({ limits: { fileSize: config.uploadMaxMb * 1024 * 1024 } })
      if (!file) return reply.code(400).send({ error: '缺少文件' })
      const ext = file.filename.toLowerCase().split('.').pop()
      if (!ACCEPT_EXT.has(ext)) return reply.code(400).send({ error: `不支持的类型 .${ext}` })

      const buf = await file.toBuffer()

      // 内容级幂等：同文件不重复摄取
      const hash = hashBuffer(buf)
      const dup = getDocByHash.get(hash)
      if (dup) return reply.send({ duplicated: true, doc: dup })

      // 原件落盘，worker 从磁盘读取
      const docId = randomUUID()
      await fs.mkdir(config.uploadsDir, { recursive: true })
      const filePath = path.join(config.uploadsDir, `${docId}.${ext}`)
      await fs.writeFile(filePath, buf)

      insertDoc.run(docId, file.filename, buf.length, hash, 0, 'pending', null, filePath)
      worker.wake()

      return reply.code(202).send({
        doc: { id: docId, filename: file.filename, size: buf.length, status: 'pending' },
      })
    } catch (e) {
      if (/RequestFileTooLargeError|file size limit/i.test(String(e))) {
        return reply.code(413).send({ error: `文件超过 ${config.uploadMaxMb}MB 限制` })
      }
      req.log.error(e)
      return reply.code(500).send({ error: e.message })
    }
  })

  app.get('/api/documents', () => listDocs.all())

  app.delete('/api/documents/:id', async (req, reply) => {
    const doc = getDoc.get(req.params.id)
    if (!doc) return reply.code(404).send({ error: '文档不存在' })
    if (doc.status === 'pending' || doc.status === 'processing') {
      return reply.code(409).send({ error: '文档正在摄取中，请稍后再删' })
    }
    if (doc.path) await fs.rm(doc.path, { force: true }).catch(() => {})
    if (doc.status === 'ready') {
      try {
        await deleteDocPoints(doc.id) // 先删向量，再删元数据
      } catch (e) {
        req.log.error(e)
        return reply.code(500).send({ error: `向量删除失败: ${e.message}` })
      }
    }
    deleteDocRow.run(doc.id)
    return reply.send({ ok: true })
  })
}
