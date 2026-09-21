// ============================================================================
// M20 写工具：submit_document（提交/替换知识库文档）
// ----------------------------------------------------------------------------
// 与只读工具不同，写工具走两段式：
//   1. toolsNode 拦截 → 落 approvals 表（status=pending）→ SSE approval_required
//   2. 用户确认 → POST /api/approvals/:id/confirm → executeWrite() 真正执行
// 安全三件套：
//   - 幂等键：idemKey = sha256(user|collection|docKey|stagingId|contentHash)，服务端按键去重
//   - 权限：canWriteDoc（新建任意 owner；替换须 owner/admin）
//   - 审计：root span 属性 rag.write_action = {user,tool,target,result,approval}
// ============================================================================

import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { ingestOne } from '../rag/ingest-one.js'
import { canWriteDoc } from '../acl.js'
import { allowedCollections } from '../domain/registry.js'
import { config } from '../config.js'
import {
  insertApproval, getApproval, setApprovalStatus, getStagingFile, deleteStagingFile, getLatestDocByKey,
} from '../store/pg.js'

// 写工具定义（LLM 工具表）：仅当 config.write.enabled 时由 tools.js 注入
export const writeToolDefs = [
  {
    type: 'function',
    function: {
      name: 'submit_document',
      description:
        '提交或替换一份知识库文档（写操作，需用户审批后执行）。' +
        '常用于：用户在对话中上传文件后让你入库、更新已有制度文档为新版本、补充缺失资料。' +
        'stagingId 来自用户在对话中上传的暂存文件（前端会告知 id）；docKey 用于版本化替换同组旧版。',
      parameters: {
        type: 'object',
        properties: {
          stagingId: { type: 'string', description: '暂存文件 ID（用户对话上传时获得）' },
          filename: { type: 'string', description: '入库存档的文件名（含扩展名，如 制度v2.md）' },
          docKey: { type: 'string', description: '版本组标识（同 docKey 已有文档会被替换为新版本）；缺省=filename' },
          collection: { type: 'string', description: '目标集合（core 留空；领域包集合如 rag_api_docs）' },
          classification: { type: 'string', enum: ['public', 'dept', 'private'], description: '密级（默认 private）' },
          tags: { type: 'array', items: { type: 'string' }, description: '受控标签（白名单内）' },
          effectiveDate: { type: 'string', description: '生效日期（ISO 串，如 2026-09-01）' },
          deprecated: { type: 'boolean', description: '是否标记为已废弃' },
          summary: { type: 'string', description: '一句话说明本次写入意图（审批卡片展示）' },
        },
        required: ['stagingId', 'filename'],
      },
    },
  },
]

/** 写工具名集合，toolsNode 据此拦截 */
export const WRITE_TOOLS = new Set(['submit_document'])

/** 配置门控：WRITE_TOOLS 关闭时写工具不进工具表、不拦截（M16 零破坏面） */
export const isWriteTool = (name) => config.write.enabled && WRITE_TOOLS.has(name)

/**
 * 生成服务端规范幂等键：用户 + 目标 + 数据源 + 内容哈希
 * 同用户对同 docKey 的同内容提交只执行一次（换文件名/标签不影响幂等性）
 */
export async function computeIdemKey(userId, args, stagingPath) {
  const buf = await fs.readFile(stagingPath)
  const contentHash = createHash('sha256').update(buf).digest('hex')
  const raw = [userId, args.collection ?? '', args.docKey ?? args.filename ?? '', contentHash].join('|')
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * 写工具拦截入口：toolsNode 检测到写工具调用时走此函数（不直接执行）。
 * 落 approval 单 → 发 SSE approval_required 事件 → 返回「等待审批」Observation 收尾本轮。
 * @returns {string} Observation（回喂 LLM，告知审批已发起、等待用户确认）
 */
export async function interceptWrite({ name, args, user, sessionId, emit, span, log }) {
  const staging = await getStagingFile(args.stagingId)
  if (!staging || staging.user_id !== user.sub) {
    return `暂存文件 ${args.stagingId} 不存在或不属于当前用户。请让用户在对话中上传文件后再调用。`
  }

  // 目标集合白名单（core + 已激活领域包）；缺省 core
  const collection = String(args.collection ?? '').trim()
  if (collection && !allowedCollections().has(collection)) {
    return `写操作未执行: 非法目标集合（未启用的领域包）。`
  }

  // 写权限预检（canWriteDoc 单点）：同 docKey 已有文档（将版本替换）须 owner/admin
  const docKey = String(args.docKey ?? '').trim() || args.filename
  const prev = await getLatestDocByKey(collection || config.qdrantCollection, docKey).catch(() => null)
  if (prev && !canWriteDoc(user, prev)) {
    return '写操作未执行: 该版本组已有文档且归其他用户所有，无写入权限。'
  }

  const idemKey = await computeIdemKey(user.sub, args, staging.path)
  const expiresAt = new Date(Date.now() + config.write.approvalTimeoutSec * 1000)
  const { approval, created } = await insertApproval(
    randomUUID(), sessionId, user.sub, name, args, idemKey, expiresAt
  )

  if (!created) {
    // 幂等命中：按既有状态给结论
    if (!approval) return '写操作登记冲突，请稍后重试。'
    if (approval.status === 'executed') return `该文档已提交（审批 ${approval.id}，已执行）。docId: ${approval.result?.docId ?? '?'}`
    if (approval.status === 'pending') return `该文档的审批单已存在（${approval.id}），等待用户确认。`
    return `该文档的审批单已 ${approval.status}（${approval.id}），不可重复提交。`
  }

  // 审计：写操作落 trace（who/what/target/approval），照 rag.injection_suspect 现成模式
  span?.setAttr?.('rag.write_action', JSON.stringify({
    user: user.sub, tool: name, target: args.docKey ?? args.filename,
    collection: args.collection ?? '', approvalId: approval.id,
  }))

  // autoApprove 模式（测试/演示）：跳过人工确认直接执行
  if (config.write.autoApprove) {
    const res = await executeWrite(approval.id, user, log)
    return res.error
      ? `写入失败：${res.error}`
      : `文档已提交：${args.filename}（docId: ${res.result?.docId}）。` +
        (res.result?.replaced ? '已替换旧版本。' : '') +
        '摄取进行中，稍后可检索。'
  }

  // SSE 事件：前端弹确认卡片
  emit?.('approval_required', {
    approvalId: approval.id,
    tool: name,
    summary: args.summary || `提交文档 ${args.filename}`,
    filename: args.filename,
    docKey: args.docKey || args.filename,
    collection: args.collection || '',
    classification: args.classification || 'private',
    tags: args.tags || [],
    effectiveDate: args.effectiveDate || '',
    deprecated: args.deprecated || false,
    expiresAt: expiresAt.toISOString(),
  })

  log?.info?.(`[write] 审批单 ${approval.id} 已创建（${user.username} → ${args.filename}），等待确认`)

  return `已发起文档提交审批（审批单 ${approval.id}）。` +
    `文件「${args.filename}」将提交到知识库${args.collection ? `（集合 ${args.collection}）` : ''}。` +
    '请等待用户在对话中确认后执行；确认前不会写入任何数据。'
}

/**
 * 执行写操作（审批通过后调用）：读暂存文件 → ingestOne → 落 result → 清暂存
 * @returns {{ result, error }}
 */
export async function executeWrite(approvalId, user, log) {
  const approval = await getApproval(approvalId)
  if (!approval || approval.status !== 'pending') {
    return { result: null, error: `审批单不可执行（状态: ${approval?.status ?? '不存在'}）` }
  }
  if (approval.expires_at && new Date(approval.expires_at) < new Date()) {
    await setApprovalStatus('expired', null, '审批超时', approvalId)
    return { result: null, error: '审批已超时' }
  }

  const args = approval.args
  const staging = await getStagingFile(args.stagingId)
  if (!staging || staging.user_id !== user.sub) {
    await setApprovalStatus('failed', null, '暂存文件不存在或无权访问', approvalId)
    return { result: null, error: '暂存文件不存在或无权访问' }
  }

  try {
    const buf = await fs.readFile(staging.path)
    // 构造与 multipart 表单同形的 fields（ingestOne 期望 {name:{value}} 形态）
    const fields = {
      classification: { value: args.classification || 'private' },
      tags: { value: args.tags },
      collection: { value: args.collection || '' },
      docKey: { value: args.docKey || '' },
      effectiveDate: { value: args.effectiveDate || '' },
      deprecated: { value: args.deprecated ? 'true' : '' },
    }
    const r = await ingestOne({ filename: args.filename, buf, fields, user, log })
    if (r.error) {
      await setApprovalStatus('failed', null, r.error, approvalId)
      return { result: null, error: r.error }
    }
    const result = {
      docId: r.doc.id, filename: r.doc.filename, status: r.doc.status,
      collection: r.doc.collection, docKey: r.doc.docKey, docVersion: r.doc.docVersion,
      replaced: r.doc.replaced ?? null, duplicated: r.duplicated ?? false,
    }
    await setApprovalStatus('executed', result, null, approvalId)
    // 清理暂存（执行成功后不再需要原件副本，原件已在 ingestOne 落盘到 uploadsDir）
    await fs.rm(staging.path, { force: true }).catch(() => {})
    await deleteStagingFile(args.stagingId)
    log?.info?.(`[write] 审批单 ${approvalId} 已执行：${result.filename} → ${result.docId}`)
    return { result, error: null }
  } catch (e) {
    await setApprovalStatus('failed', null, e.message, approvalId)
    log?.error?.(`[write] 审批单 ${approvalId} 执行失败: ${e.message}`)
    return { result: null, error: e.message }
  }
}
