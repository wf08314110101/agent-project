// ============================================================================
// 文档管理路由：上传（异步摄取）/ 列表 / 删除
// ----------------------------------------------------------------------------
// 上传是异步的：接口只做"校验 + 去重 + 落盘 + 入队"即返回 202，
// 解析/切块/嵌入由 ingest worker 后台完成，前端通过列表接口轮询 status。
// 删除是同步的：先删原件与向量，最后删元数据行，保证向量与元数据一致。
// ============================================================================

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ACCEPT_EXT, hashBuffer } from '../rag/parser.js'
import { createIngestWorker, ingestBus } from '../rag/ingest.js'
import { insertDoc, listDocsByUser, getDoc, getDocByHash, deleteDocRow } from '../store/sqlite.js'
import { deleteDocPoints } from '../rag/qdrant.js'
import { config } from '../config.js'

export default async function (app) {
  // 独立的临时 worker 实例：仅用于上传后 wake() 队列（不重复跑循环）
  const worker = createIngestWorker(app.log)

  // M3 异步摄取：校验+去重+落盘入队即返回 202，解析/切块/嵌入由 worker 后台做，前端轮询状态
  app.post('/api/documents', async (req, reply) => {
    try {
      // 接收单个文件，并施加大小限制（超限抛 RequestFileTooLargeError）
      const file = await req.file({ limits: { fileSize: config.uploadMaxMb * 1024 * 1024 } })
      if (!file) return reply.code(400).send({ error: '缺少文件' })
      // 扩展名白名单校验（parser.js 中同名单，双保险）
      const ext = file.filename.toLowerCase().split('.').pop()
      if (!ACCEPT_EXT.has(ext)) return reply.code(400).send({ error: `不支持的类型 .${ext}` })

      const buf = await file.toBuffer() // 一次性读入内存（已有 fileSize 上限保护）

      // 内容级幂等：同文件不重复摄取（SHA-256 相同即视为重复，改文件名也不影响）
      // 归属语义：hash 全库唯一（知识库是共享池，同一内容只嵌一份向量）；
      // 本人重复上传 → duplicated 跳过；他人已传 → 409 提示，不重复占存储
      const hash = hashBuffer(buf)
      const dup = getDocByHash.get(hash)
      if (dup) {
        if (dup.user_id === req.user.sub) return reply.send({ duplicated: true, doc: dup })
        return reply.code(409).send({ error: '相同内容的文档已存在（由其他用户上传）' })
      }

      // 原件落盘，worker 从磁盘读取（接口尽快返回，不做重活）
      const docId = randomUUID()
      await fs.mkdir(config.uploadsDir, { recursive: true })
      const filePath = path.join(config.uploadsDir, `${docId}.${ext}`)
      await fs.writeFile(filePath, buf)

      // 元数据入队：status=pending，挂当前用户归属，worker 会 wake 起来消费
      insertDoc.run(docId, file.filename, buf.length, hash, 0, 'pending', null, filePath, req.user.sub)
      worker.wake()

      // 202 Accepted：任务已受理，尚未完成
      return reply.code(202).send({
        doc: { id: docId, filename: file.filename, size: buf.length, status: 'pending' },
      })
    } catch (e) {
      // 大小超限 → 413；其余 → 500
      if (/RequestFileTooLargeError|file size limit/i.test(String(e))) {
        return reply.code(413).send({ error: `文件超过 ${config.uploadMaxMb}MB 限制` })
      }
      req.log.error(e)
      return reply.code(500).send({ error: e.message })
    }
  })

  // 文档列表：当前用户自己的，按创建时间倒序，含 status/chunks/error
  app.get('/api/documents', (req) => listDocsByUser.all(req.user.sub))

  // 摄取进度 SSE：连接即推一帧全量快照（docs 事件），之后订阅 worker 的 doc 事件实时推送
  // 替代前端 1.5s 轮询；仅推本人文档（事件带 user_id，订阅侧过滤）。nginx 反代需 x-accel-buffering: no
  app.get('/api/documents/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('docs', { docs: listDocsByUser.all(req.user.sub) }) // 快照：前端连接后无需再拉一次列表

    const onDoc = (d) => {
      if (d.user_id !== req.user.sub) return // 只推本人文档
      send('doc', d)
    }
    ingestBus.on('doc', onDoc)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000) // 心跳防代理断长连接
    req.raw.on('close', () => {
      clearInterval(ping)
      ingestBus.off('doc', onDoc)
    })
  })

  // 删除文档：只在"非摄取中"时允许；仅限本人文档；顺序 = 原件 → 向量 → 元数据行
  app.delete('/api/documents/:id', async (req, reply) => {
    const doc = getDoc.get(req.params.id)
    if (!doc || doc.user_id !== req.user.sub) return reply.code(404).send({ error: '文档不存在' })
    // 摄取中的文档正在被 worker 占用，删除会造成状态错乱，返回 409 冲突
    if (doc.status === 'pending' || doc.status === 'processing') {
      return reply.code(409).send({ error: '文档正在摄取中，请稍后再删' })
    }
    // 原件可能已删（ready 时 worker 删过）或不存在（failed），force 忽略不存在
    if (doc.path) await fs.rm(doc.path, { force: true }).catch(() => {})
    if (doc.status === 'ready') {
      try {
        await deleteDocPoints(doc.id) // 先删向量，再删元数据
      } catch (e) {
        // 向量删除失败时保留元数据行：否则会留下"搜得到但看不到"的孤儿向量
        req.log.error(e)
        return reply.code(500).send({ error: `向量删除失败: ${e.message}` })
      }
    }
    deleteDocRow.run(doc.id)
    return reply.send({ ok: true })
  })
}
