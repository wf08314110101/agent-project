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
  deleteGrantsByDoc, listGrantsByDoc, grantDoc, revokeGrant, getUserByName, getUserById, getLatestDocByKey,
} from '../store/pg.js'
import { deleteDocPoints, setDocAclPayload } from '../rag/qdrant.js'
import { bumpKbEpoch } from '../rag/answer-cache.js'
import { canReadDoc, CLASSIFICATIONS, sanitizeTags } from '../acl.js'
import { config } from '../config.js'
import { packs } from '../domain/registry.js'

// M17 允许的目标集合：core（缺省）+ 已激活领域包集合（白名单校验，防任意集合注入）
const ALLOWED_COLLECTIONS = () => new Set([config.qdrantCollection, ...packs.map((p) => p.collection)])

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
      // M17 目标集合（可选）：不传 = core；仅接受白名单内的领域集合
      const collection = String(file.fields?.collection?.value ?? '').trim()
      if (collection && !ALLOWED_COLLECTIONS().has(collection)) {
        return reply.code(400).send({ error: `非法集合 ${collection}（未启用的领域包）` })
      }
      // M18 语料时效：docKey = 版本组标识（缺省文件名）+ 生效日期（自由文本，进上下文/前端展示）
      // docVersion/deprecated 仅评估脚本 sidecar/显式声明用（正常上传由替换链路推导版本号）
      const docKey = String(file.fields?.docKey?.value ?? '').trim() || file.filename
      const effectiveDate = String(file.fields?.effectiveDate?.value ?? '').trim().slice(0, 32)
      const explicitVersion = Number(file.fields?.docVersion?.value) || null
      const deprecated = String(file.fields?.deprecated?.value ?? '').trim() === 'true'
      // 版本化替换开关：on=全替换；auto=仅领域集合替换（core 缺省共存，零破坏）；off=不替换
      const targetCollection = collection || config.qdrantCollection
      const replaceOn = config.docReplaceMode === 'on' ||
        (config.docReplaceMode === 'auto' && collection && collection !== config.qdrantCollection)

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

      // M18 版本化替换：同 docKey 已有文档且内容变化 → 新行 doc_version+1，旧行级联删除
      // （向量/授权随删，与领域连接器同语义）；摄取中不可替换（409），防 worker 竞态
      const prev = replaceOn ? await getLatestDocByKey(targetCollection, docKey) : null
      if (prev && (prev.status === 'pending' || prev.status === 'processing')) {
        return reply.code(409).send({ error: '旧版本正在摄取中，请稍后再传' })
      }

      // 原件落盘，worker 从磁盘读取（接口尽快返回，不做重活）
      const docId = randomUUID()
      await fs.mkdir(config.uploadsDir, { recursive: true })
      const filePath = path.join(config.uploadsDir, `${docId}.${ext}`)
      await fs.writeFile(filePath, buf)

      // 元数据入队：status=pending，挂当前用户归属，worker 会 wake 起来消费
      await insertDoc(docId, file.filename, buf.length, hash, 0, 'pending', null, filePath, req.user.sub, classification, tags, {
        collection: collection || undefined,
        docKey,
        effectiveDate,
        docVersion: explicitVersion ?? (prev ? (prev.doc_version ?? 1) + 1 : 1),
        deprecated,
      })
      worker.wake()

      // 替换收尾：新行已落库后再删旧行（删除失败的窗口期内新旧共存，检索层版本消解兜底）
      if (prev) {
        if (prev.status === 'ready') await deleteDocPoints(prev.id, prev.collection).catch((e) => req.log.warn(e.message))
        await deleteDocRow(prev.id)
        await deleteGrantsByDoc(prev.id)
      }

      // 202 Accepted：任务已受理，尚未完成
      return reply.code(202).send({
        doc: {
          id: docId, filename: file.filename, size: buf.length, status: 'pending', classification, tags,
          collection: targetCollection, docKey, effectiveDate,
          docVersion: explicitVersion ?? (prev ? (prev.doc_version ?? 1) + 1 : 1), deprecated, replaced: prev?.id ?? null,
        },
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

  // 原文预览（M17）：canReadDoc 单点鉴权 + 原样返回文件字节，渲染交给浏览器原生
  // Content-Type 按扩展名映射：pdf → application/pdf（浏览器阅读器）；md/txt/html 一律
  // text/plain——html 不允许 inline 打开（blob URL 继承同源会执行脚本，XSS 面必须关死）。
  // 不可读按 404（不泄露存在性）；原件缺失（未落盘/已清理）也 404，前端仅 ready 可点。
  app.get('/api/documents/:id/content', async (req, reply) => {
    const doc = await getDoc(req.params.id)
    if (!doc || !(await canReadDoc(req.user, doc))) return reply.code(404).send({ error: '文档不存在' })
    const buf = await fs.readFile(doc.path).catch(() => null)
    if (buf == null) return reply.code(404).send({ error: '原文缺失' })
    const ext = doc.filename.toLowerCase().split('.').pop()
    return reply.type(ext === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8').send(buf)
  })

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
      }, doc.collection).catch((e) => req.log.warn(`[acl] payload 同步失败: ${e.message}`))
    }

    const updated = await getDoc(doc.id)
    // 可见性变化（密级/授权）→ 该集合 KB 纪元 +1：回答缓存全量失效（ID6/M17 按集合分桶）
    if (classification !== undefined || grants !== undefined) await bumpKbEpoch(doc.collection)
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
        await deleteDocPoints(doc.id, doc.collection) // 先删向量，再删元数据（M17 按文档所属集合删）
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
