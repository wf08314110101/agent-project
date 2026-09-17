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
import {
  insertDoc, listDocsVisible, listDocsAll, updateDocMeta, getDoc, getDocByHash, deleteDocRow,
  deleteGrantsByDoc, listGrantsByDoc, grantDoc, revokeGrant, getUserByName, getUserById,
} from '../store/pg.js'
import { deleteDocPoints, setDocAclPayload } from '../rag/qdrant.js'
import { bumpKbEpoch } from '../rag/answer-cache.js'
import { CLASSIFICATIONS, sanitizeTags } from '../acl.js'
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
      // M10 RBAC：密级（默认 private，最小暴露面）+ 标签（受控枚举白名单）
      const classification = String(file.fields?.classification?.value ?? 'private')
      if (!CLASSIFICATIONS.includes(classification)) return reply.code(400).send({ error: `密级必须是 ${CLASSIFICATIONS.join('/')}` })
      const tags = sanitizeTags(file.fields?.tags?.value)

      const buf = await file.toBuffer() // 一次性读入内存（已有 fileSize 上限保护）

      // 内容级幂等：同文件不重复摄取（SHA-256 相同即视为重复，改文件名也不影响）
      // 归属语义：hash 全库唯一（知识库是共享池，同一内容只嵌一份向量）；
      // 本人重复上传 → duplicated 跳过；他人已传 → 409 提示，不重复占存储
      const hash = hashBuffer(buf)
      const dup = await getDocByHash(hash)
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
      await insertDoc(docId, file.filename, buf.length, hash, 0, 'pending', null, filePath, req.user.sub, classification, tags)
      worker.wake()

      // 202 Accepted：任务已受理，尚未完成
      return reply.code(202).send({
        doc: { id: docId, filename: file.filename, size: buf.length, status: 'pending', classification, tags },
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

  // 文档列表：可见集合 = 本人 ∪ public ∪ 同部门(dept) ∪ 被授权；admin 全量（按创建时间倒序）
  app.get('/api/documents', async (req) =>
    req.user.role === 'admin' ? listDocsAll() : listDocsVisible(req.user.sub, req.user.dept)
  )

  // 摄取进度 SSE：连接即推一帧全量快照（docs 事件），之后订阅 worker 的 doc 事件实时推送
  // 快照与列表接口同口径（可见集合）；doc 事件仅推本人文档（admin 额外收全部），他人文档变化靠刷新列表
  app.get('/api/documents/events', async (req, reply) => {
    const snapshot = () =>
      req.user.role === 'admin' ? listDocsAll() : listDocsVisible(req.user.sub, req.user.dept)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('docs', { docs: await snapshot() })

    const onDoc = (d) => {
      if (d.user_id !== req.user.sub && req.user.role !== 'admin') return // 只推本人文档
      send('doc', d)
    }
    ingestBus.on('doc', onDoc)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000) // 心跳防代理断长连接
    req.raw.on('close', () => {
      clearInterval(ping)
      ingestBus.off('doc', onDoc)
    })
  })

  // 密级/标签/授权变更（M10）：仅 owner 或 admin；ready 文档同步刷 Qdrant payload 即时生效
  app.patch('/api/documents/:id', async (req, reply) => {
    const doc = await getDoc(req.params.id)
    if (!doc || (doc.user_id !== req.user.sub && req.user.role !== 'admin')) {
      return reply.code(404).send({ error: '文档不存在' })
    }
    const { classification, tags, grants } = req.body ?? {}

    // 授权变更（usernames 数组，整体替换语义）：先解析成 userId，未知用户名直接 400
    if (grants !== undefined) {
      if (!Array.isArray(grants)) return reply.code(400).send({ error: 'grants 必须是用户名数组' })
      const ids = []
      for (const name of grants) {
        const u = await getUserByName(String(name))
        if (!u) return reply.code(400).send({ error: `用户不存在: ${name}` })
        if (u.id !== doc.user_id) ids.push(u.id) // owner 无需授权
      }
      const cur = new Set((await listGrantsByDoc(doc.id)).map((g) => g.user_id))
      const next = new Set(ids)
      for (const uid of next) if (!cur.has(uid)) await grantDoc(doc.id, uid)
      for (const uid of cur) if (!next.has(uid)) await revokeGrant(doc.id, uid)
    }

    // 密级/标签变更：受控枚举校验；同步 Qdrant payload，检索即时生效（无需重摄）
    const nextCls = classification ?? doc.classification
    if (!CLASSIFICATIONS.includes(nextCls)) return reply.code(400).send({ error: `密级必须是 ${CLASSIFICATIONS.join('/')}` })
    const nextTags = tags === undefined ? doc.tags : sanitizeTags(tags) // JSONB：数组直存直读
    await updateDocMeta(nextCls, nextTags, doc.id)
    const owner = await getUserById(doc.user_id) // ownerDept 实时值（部门改码后无需重摄）
    if (doc.status === 'ready') {
      await setDocAclPayload(doc.id, {
        ownerId: doc.user_id,
        classification: nextCls,
        ownerDept: owner?.dept ?? '',
      }).catch((e) => req.log.warn(`[acl] payload 同步失败: ${e.message}`))
    }

    const updated = await getDoc(doc.id)
    // 可见性变化（密级/授权）→ KB 纪元 +1：回答缓存全量失效（ID6）
    if (classification !== undefined || grants !== undefined) await bumpKbEpoch()
    const grants2 = await listGrantsByDoc(doc.id)
    const names = (await Promise.all(grants2.map((g) => getUserById(g.user_id)))).map((u) => u?.username).filter(Boolean)
    return reply.send({ ...updated, grants: names })
  })

  // 删除文档：只在"非摄取中"时允许；仅限本人或 admin；顺序 = 原件 → 向量 → 元数据行（+授权行）
  app.delete('/api/documents/:id', async (req, reply) => {
    const doc = await getDoc(req.params.id)
    if (!doc || (doc.user_id !== req.user.sub && req.user.role !== 'admin')) return reply.code(404).send({ error: '文档不存在' })
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
    await deleteDocRow(doc.id)
    await deleteGrantsByDoc(doc.id) // 授权行随文档级联清理
    return reply.send({ ok: true })
  })
}
