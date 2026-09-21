// ============================================================================
// 文档管理路由：上传（异步摄取）/ 列表 / 删除
// ----------------------------------------------------------------------------
// 上传是异步的：接口只做"校验 + 去重 + 落盘 + 入队"即返回 202，
// 解析/切块/嵌入由 ingest worker 后台完成，前端通过列表接口轮询 status。
// 删除是同步的：先删原件与向量，最后删元数据行，保证向量与元数据一致。
// ============================================================================

import fs from 'node:fs/promises'
import yauzl from 'yauzl'
import { ACCEPT_EXT } from '../rag/parser.js'
import { ingestBus } from '../rag/ingest.js'
import { ingestOne, extOf } from '../rag/ingest-one.js' // M20：摄取单文件语义上移共享模块
import {
  listDocsVisible, listDocsAll, updateDocMeta, getDoc, deleteDocRow,
  deleteGrantsByDoc, listGrantsByDoc, grantDoc, revokeGrant, getUserByName, getUserById,
} from '../store/pg.js'
import { deleteDocPoints, setDocAclPayload } from '../rag/qdrant.js'
import { bumpKbEpoch } from '../rag/answer-cache.js'
import { canReadDoc, CLASSIFICATIONS, sanitizeTags } from '../acl.js'
import { config } from '../config.js'

// M19 zip 防护闸：条目数与解压总量上限（防 zip bomb）
const ZIP_MAX_FILES = 100
const ZIP_MAX_BYTES = 100 * 1024 * 1024

export default async function (app) {
  // M19 zip 解压：仅收白名单扩展，跳过目录/嵌套包/系统垃圾（__MACOSX 等）；
  // 条目数与总解压量双闸，超限整包拒绝。
  // decodeStrings=false：yauzl 对无 UTF-8 标志的包名按 CP437 解码（macOS zip 打中文包必乱码），
  // 改为拿原始字节自行解码——UTF-8 严格模式优先，失败回退 latin1。
  function decodeName(b) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b)
    } catch {
      return b.toString('latin1')
    }
  }

  function unzip(buf) {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, zip) => {
        if (err) return reject(new Error('压缩包无法解析'))
        const out = []
        let total = 0
        let overflow = false
        zip.on('error', () => reject(new Error('压缩包无法解析')))
        zip.on('entry', (entry) => {
          const name = decodeName(entry.fileName)
          const ext = extOf(name)
          const okFile =
            !name.endsWith('/') && !name.includes('__MACOSX') && !name.split('/').pop().startsWith('.') &&
            ext !== 'zip' && ACCEPT_EXT.has(ext)
          if (!okFile) return zip.readEntry()
          if (out.length >= ZIP_MAX_FILES) {
            overflow = true
            zip.close()
            return reject(new Error(`压缩包内可摄取文件超过 ${ZIP_MAX_FILES} 个上限`))
          }
          zip.openReadStream(entry, (e, rs) => {
            if (e) return zip.readEntry()
            const chunks = []
            rs.on('data', (c) => {
              total += c.length
              if (total <= ZIP_MAX_BYTES) chunks.push(c)
            })
            rs.on('end', () => {
              if (total > ZIP_MAX_BYTES) {
                overflow = true
                zip.close()
                return reject(new Error('压缩包解压总量超过 100MB 上限'))
              }
              out.push({ filename: name, data: Buffer.concat(chunks) }) // filename = zip 内路径
              zip.readEntry()
            })
          })
        })
        zip.on('end', () => (overflow ? undefined : resolve(out)))
        zip.readEntry()
      })
    })
  }

  /**
   * 单文件摄取语义已上移 [rag/ingest-one.js](../src/rag/ingest-one.js)（M20）：
   * 上传路由与写工具审批执行共用同一套校验/去重/版本替换管线。
   */

  // M3 异步摄取：校验+去重+落盘入队即返回 202，解析/切块/嵌入由 worker 后台做，前端轮询状态
  app.post('/api/documents', async (req, reply) => {
    try {
      // M21 修复：逐 part 消费完整 multipart——原 req.file()+toBuffer 可能在尾随 field part
      // 到达前返回，collection/docKey 等偶发丢失；for-await 消费完整个流保证字段齐全
      const limits = { fileSize: config.uploadMaxMb * 1024 * 1024 }
      let file = null
      let buf = null
      const fields = {} // 与 file.fields 同形态：{ name: part }（part.value 取值）
      for await (const part of req.parts({ limits })) {
        if (part.type === 'file') {
          if (file) continue // 单文件语义：只取首个文件 part，其余排空
          file = part
          buf = await part.toBuffer()
        } else {
          fields[part.fieldname] = part
        }
      }
      if (!file) return reply.code(400).send({ error: '缺少文件' })
      // 扩展名白名单校验（parser.js 中同名单，双保险）
      const ext = extOf(file.filename)
      if (!ACCEPT_EXT.has(ext)) return reply.code(400).send({ error: `不支持的类型 .${ext}` })

      // M19 zip：路由层解压为多个独立文档（每 entry 一个 docId），表单字段作用于包内全部文件；
      // 响应为 {docs:[...]} 数组（单文件仍为 {doc}，前端兼容）
      if (ext === 'zip') {
        const entries = await unzip(buf)
        if (!entries.length) return reply.code(400).send({ error: '压缩包内没有可摄取的文件' })
        const docs = []
        for (const en of entries) {
          const r = await ingestOne({ filename: en.filename, buf: en.data, fields, user: req.user, log: req.log })
          docs.push({ filename: en.filename, ...(r.error ? { error: r.error } : r.duplicated ? { duplicated: true, doc: r.doc } : { doc: r.doc }) })
        }
        return reply.code(202).send({ docs })
      }

      const r = await ingestOne({ filename: file.filename, buf, fields, user: req.user, log: req.log })
      if (r.error) return reply.code(r.code).send({ error: r.error })
      if (r.duplicated) return reply.send({ duplicated: true, doc: r.doc })
      // 202 Accepted：任务已受理，尚未完成
      return reply.code(202).send({ doc: r.doc })
    } catch (e) {
      // 大小超限 → 413；zip 防护闸 → 400；其余 → 500
      if (/RequestFileTooLargeError|file size limit/i.test(String(e))) {
        return reply.code(413).send({ error: `文件超过 ${config.uploadMaxMb}MB 限制` })
      }
      if (/压缩包|解压总量/.test(e.message)) return reply.code(400).send({ error: e.message })
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
