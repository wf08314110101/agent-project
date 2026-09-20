// ============================================================================
// 数据连接器（api-docs）：GitHub md 文档仓库 → 现有摄取队列（队列零改动）
// ----------------------------------------------------------------------------
// 流程：GitHub API 拿文件树 → 过滤 .md → raw 下载 → hash 去重 → 同源变更处置
//       （内容变化 = 删旧版本行+向量 → 插新行 doc_version+1）→ 落盘 pending 行，
//       worker 3s 兜底轮询自然消费（跨进程安全，无需 wake）。
// 幂等：重跑时 hash 相同全部跳过；失败单文件跳过不中断。
// 语料治理：source_url 记溯源（fetch_api_doc 与前端引用用），deprecated 由配置路径
//       声明（如 docs/v1/ 子目录），doc_version 随内容变更自增。
// ============================================================================

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config.js'
import { hashBuffer } from '../../rag/parser.js'
import { deleteDocPoints } from '../../rag/qdrant.js'
import { insertDoc, getDocByHash, getDocBySourceUrl, deleteDocRow, deleteGrantsByDoc } from '../../store/pg.js'
import { pack } from './meta.js'

const TIMEOUT_MS = 15_000
const MAX_FILES = Number(process.env.DOMAIN_SYNC_MAX_FILES ?? 40)
const UA = 'agentic-rag-connector/0.1'

const gh = async (url) => {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json', ...(config.domain.githubToken ? { authorization: `Bearer ${config.domain.githubToken}` } : {}) },
  })
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${url}`)
  return r.json()
}

/** 单次同步：返回 { added, updated, skipped }；抛错由调用方（registry 定时/手动脚本）兜住 */
export async function syncOnce() {
  const { repo, branch, dir, deprecatedDir, tags } = pack
  const tree = await gh(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`)
  const files = (tree.tree ?? [])
    .filter((n) => n.type === 'blob' && n.path.endsWith('.md') && n.path.startsWith(dir))
    .slice(0, MAX_FILES)
  if (!files.length) throw new Error(`仓库 ${repo}@${branch} 在 ${dir} 下未找到 md 文件`)

  const stats = { added: 0, updated: 0, skipped: 0, failed: 0 }
  for (const f of files) {
    try {
      const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${f.path}`
      const r = await fetch(rawUrl, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA } })
      if (!r.ok) throw new Error(`raw HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length) throw new Error('空文件')
      const hash = hashBuffer(buf)
      if (await getDocByHash(hash)) { stats.skipped++; continue } // 内容未变：幂等跳过

      const prev = await getDocBySourceUrl(rawUrl)
      let docVersion = 1
      if (prev) {
        // 同源内容变更：旧版本行+向量+授权级联删除，新行 doc_version 递增（版本化替换）
        if (prev.status === 'ready') await deleteDocPoints(prev.id, pack.collection)
        await deleteDocRow(prev.id)
        await deleteGrantsByDoc(prev.id).catch(() => {})
        docVersion = (prev.doc_version ?? 1) + 1
      }

      const docId = randomUUID()
      await fs.mkdir(config.uploadsDir, { recursive: true })
      const filePath = path.join(config.uploadsDir, `${docId}.md`)
      await fs.writeFile(filePath, buf)
      // connector 语料统一 public（服务级只读知识源，owner 空）；密级/标签与 core 上传链路同语义
      await insertDoc(docId, f.path, buf.length, hash, 0, 'pending', null, filePath, '', 'public', tags, {
        collection: pack.collection,
        sourceUrl: rawUrl,
        docVersion,
        deprecated: deprecatedDir ? f.path.startsWith(deprecatedDir) : false,
      })
      prev ? stats.updated++ : stats.added++
    } catch {
      stats.failed++ // 单文件失败不中断整体同步
    }
  }
  return stats
}
