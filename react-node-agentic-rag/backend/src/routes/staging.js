// ==========================================================================
// M20 暂存上传：对话内上传文件先落盘 + staging_files 表，不直接入库
// 消息体只带 stagingId → agent 调 submit_document → 审批通过后才 ingestOne
// ==========================================================================

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ACCEPT_EXT } from '../rag/parser.js'
import { insertStagingFile, deleteStagingFile, deleteStagingOlderThan, getStagingFile } from '../store/pg.js'
import { config } from '../config.js'

const MAX_SIZE = 50 * 1024 * 1024 // 50MB

export default async function (app) {
  // POST /api/staging — multipart 单文件上传到暂存区
  app.post('/api/staging', async (req, reply) => {
    if (!config.write.enabled) return reply.code(403).send({ error: '写能力未开启' })

    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '缺少文件' })

    const ext = path.extname(file.filename).toLowerCase().slice(1)
    if (!ACCEPT_EXT.has(ext)) return reply.code(400).send({ error: `不支持的文件类型 .${ext}` })

    const buf = await file.toBuffer()
    if (buf.length > MAX_SIZE) return reply.code(413).send({ error: '文件超过 50MB 上限' })

    const id = randomUUID()
    const dir = path.join(config.uploadsDir, 'staging')
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${id}.${ext}`)
    await fs.writeFile(filePath, buf)

    await insertStagingFile(id, req.user.sub, file.filename, buf.length, filePath)

    return { stagingId: id, filename: file.filename, size: buf.length }
  })

  // DELETE /api/staging/:id — 用户主动撤回暂存（或前端清理）
  app.delete('/api/staging/:id', async (req, reply) => {
    const { id } = req.params
    const st = await getStagingFile(id).catch(() => null)
    if (!st || st.user_id !== req.user.sub) return reply.code(404).send({ error: '暂存文件不存在' })
    await fs.rm(st.path, { force: true }).catch(() => {})
    await deleteStagingFile(id)
    return { ok: true }
  })

  // 启动时 + 定时清理过期暂存（与审批 TTL 同步：approval 过期则暂存也无意义）
  const cleanup = async () => {
    const cutoff = new Date(Date.now() - config.write.approvalTimeoutSec * 1000).toISOString()
    const rows = await deleteStagingOlderThan(cutoff)
    for (const r of rows) await fs.rm(r.path, { force: true }).catch(() => {})
    if (rows.length) app.log.info(`[staging] 清理 ${rows.length} 个过期暂存文件`)
  }
  setInterval(cleanup, 60_000).unref?.()
  cleanup().catch(() => {})
}
