// ============================================================================
// 摄取单文件语义（M20 从 documents.js 抽出）：上传路由与写工具（审批执行）共用
// ----------------------------------------------------------------------------
// 校验 → 去重 → 版本替换判定 → 落盘 → 入队 → 收尾旧版本。
// 返回结构化结果而非 HTTP 响应：{ doc } | { duplicated, doc } | { code, error }，
// 调用方自行映射（HTTP 状态码 / Observation / 审批结论）。
// ============================================================================

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { IMG_EXT, hashBuffer } from './parser.js'
import { ocrEnabled } from './ocr.js'
import { createIngestWorker } from './ingest.js'
import { insertDoc, getDocByHash, getLatestDocByKey, deleteDocRow, deleteGrantsByDoc } from '../store/pg.js'
import { deleteDocPoints } from './qdrant.js'
import { CLASSIFICATIONS, sanitizeTags } from '../acl.js'
import { config } from '../config.js'
import { allowedCollections } from '../domain/registry.js'

export const extOf = (name) => String(name).toLowerCase().split('.').pop()

// 唤醒专用 worker 单例：仅用于入队后 wake()（消费循环在 server.js 常驻实例里）
const waker = createIngestWorker(null)

/**
 * 单文件摄取语义（M19 抽取，M20 上移为共享模块）：
 * @param {string} filename - 文件名（zip 场景 = 包内路径）
 * @param {Buffer} buf      - 文件内容
 * @param {object} fields   - multipart 表单字段（{name:{value}} 形态）；写工具路径手工构造同形
 * @param {object} user     - req.user（归属 + 写路径 canWriteDoc 判定依据）
 */
export async function ingestOne({ filename, buf, fields, user, log }) {
  const ext = extOf(filename)
  // M19 图片必须 OCR 可用，否则解析结果必为空，提前给明确错误
  if (IMG_EXT.has(ext) && !ocrEnabled()) return { code: 400, error: '未配置 OCR_MODEL，无法解析图片文件' }
  // M10 RBAC：密级（默认 private，最小暴露面）+ 标签（受控枚举白名单）
  const classification = String(fields?.classification?.value ?? 'private')
  if (!CLASSIFICATIONS.includes(classification)) return { code: 400, error: `密级必须是 ${CLASSIFICATIONS.join('/')}` }
  const tags = sanitizeTags(fields?.tags?.value)
  // M17 目标集合（可选）：不传 = core；仅接受白名单内的领域集合
  const collection = String(fields?.collection?.value ?? '').trim()
  if (collection && !allowedCollections().has(collection)) {
    return { code: 400, error: `非法集合 ${collection}（未启用的领域包）` }
  }
  // M18 语料时效：docKey = 版本组标识（缺省文件名）+ 生效日期（自由文本，进上下文/前端展示）
  const docKey = String(fields?.docKey?.value ?? '').trim() || filename
  const effectiveDate = String(fields?.effectiveDate?.value ?? '').trim().slice(0, 32)
  const explicitVersion = Number(fields?.docVersion?.value) || null
  const deprecated = String(fields?.deprecated?.value ?? '').trim() === 'true'
  // 版本化替换开关：on=全替换；auto=仅领域集合替换（core 缺省共存，零破坏）；off=不替换
  const targetCollection = collection || config.qdrantCollection
  const replaceOn = config.docReplaceMode === 'on' ||
    (config.docReplaceMode === 'auto' && collection && collection !== config.qdrantCollection)

  // 内容级幂等：同文件不重复摄取（SHA-256 相同即视为重复，改文件名也不影响）
  const hash = hashBuffer(buf)
  const dup = await getDocByHash(hash)
  if (dup) {
    if (dup.user_id === user.sub) return { duplicated: true, doc: dup }
    return { code: 409, error: '相同内容的文档已存在（由其他用户上传）' }
  }

  // M18 版本化替换：同 docKey 已有文档且内容变化 → 新行 doc_version+1，旧行级联删除
  const prev = replaceOn ? await getLatestDocByKey(targetCollection, docKey) : null
  if (prev && (prev.status === 'pending' || prev.status === 'processing')) {
    return { code: 409, error: '旧版本正在摄取中，请稍后再传' }
  }

  // 原件落盘，worker 从磁盘读取（接口尽快返回，不做重活）
  const docId = randomUUID()
  await fs.mkdir(config.uploadsDir, { recursive: true })
  const filePath = path.join(config.uploadsDir, `${docId}.${ext}`)
  await fs.writeFile(filePath, buf)

  // 元数据入队：status=pending，挂当前用户归属，worker 会 wake 起来消费
  await insertDoc(docId, filename, buf.length, hash, 0, 'pending', null, filePath, user.sub, classification, tags, {
    collection: collection || undefined,
    docKey,
    effectiveDate,
    docVersion: explicitVersion ?? (prev ? (prev.doc_version ?? 1) + 1 : 1),
    deprecated,
  })
  waker.wake()

  // 替换收尾：新行已落库后再删旧行（删除失败的窗口期内新旧共存，检索层版本消解兜底）
  if (prev) {
    if (prev.status === 'ready') await deleteDocPoints(prev.id, prev.collection).catch((e) => log?.warn?.(e.message))
    await deleteDocRow(prev.id)
    await deleteGrantsByDoc(prev.id)
  }

  return {
    doc: {
      id: docId, filename, size: buf.length, status: 'pending', classification, tags,
      collection: targetCollection, docKey, effectiveDate,
      docVersion: explicitVersion ?? (prev ? (prev.doc_version ?? 1) + 1 : 1), deprecated, replaced: prev?.id ?? null,
    },
  }
}
