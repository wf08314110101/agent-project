// ============================================================================
// MCP Server（M13）：把知识库暴露为 Model Context Protocol 服务
// ----------------------------------------------------------------------------
// 面向 Cursor / Claude Code / Inspector 等 MCP 客户端，全部工具只读：
//   rag_search     混合检索（复用 hybridSearch，ACL 下沉 Qdrant 服务端过滤）
//   rag_list_docs  文档列表（服务身份可见范围）
//   rag_doc_status 单文档摄取状态（不可读按 404 语义，不泄露存在性）
//   rag_stats      文档/向量点统计（countPoints 自带 30s 缓存）
// Resources: rag://docs/{docId} → 文档分块拼回全文（同走 canReadDoc）
// 观测：每次 tools/call 记 otelSpan（Langfuse/Phoenix 按 initObs 配置扇出）
// 安全：服务身份 = MCP_ACCESS_USER 指定的预置用户（role/dept 实时查库），
//       未配置则退化为「仅 public」匿名身份；不暴露任何写操作工具。
// ============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { config } from '../config.js'
import {
  getUserByName,
  listGrantsForUser,
  listDocsVisible,
  listDocsAll,
  getDoc,
} from '../store/pg.js'
import { hybridSearch, countPoints, scrollDocPoints } from '../rag/qdrant.js'
import { embedOne } from '../rag/embedder.js'
import { canReadDoc, aclFor } from '../acl.js'
import { otelSpan } from '../obs/otel.js'
import { validateSchema } from '../schema.js'
import { activeCollection } from '../domain/registry.js'

// ---- 工具定义：JSON Schema（MCP 规范原生格式，同时喂给校验器做最后一道防线）----
export const TOOL_DEFS = [
  {
    name: 'rag_search',
    description:
      '在 agentic-rag 知识库中做混合检索（稠密语义 + 稀疏 BM25，RRF 融合），返回带相似度分数的资料块。涉及文档内容、事实、概念的问题应调用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问题，完整的自然语言问句' },
        k: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 5' },
        docId: { type: 'string', description: '限定在某文档内检索（可选，用 rag_list_docs 获取 id）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'rag_list_docs',
    description: '列出知识库文档（按服务身份 ACL 可见范围），含密级/标签/分块数/摄取状态。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '本页条数，默认 20' },
        offset: { type: 'integer', minimum: 0, description: '偏移量，默认 0' },
      },
    },
  },
  {
    name: 'rag_doc_status',
    description: '查询某文档的摄取状态（pending/processing/ready/failed）与元数据。',
    inputSchema: {
      type: 'object',
      properties: { docId: { type: 'string', description: '文档 id' } },
      required: ['docId'],
    },
  },
  {
    name: 'rag_stats',
    description: '知识库统计：可见文档数（按摄取状态分组）与向量点总数。',
    inputSchema: { type: 'object', properties: {} },
  },
]

const clamp = (v, min, max, d) => {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

// ---- 服务身份：进程内缓存一次（改 MCP_ACCESS_USER 需重启；只读场景可接受）----
let svcUser = null
export async function serviceUser(log = console) {
  if (svcUser) return svcUser
  const name = config.mcp.accessUser
  if (name) {
    const u = await getUserByName(name)
    if (u) {
      svcUser = { sub: u.id, role: u.role || 'member', dept: u.dept || '' }
      return svcUser
    }
    log.warn?.(`[mcp] MCP_ACCESS_USER=${name} 不存在，退化为仅 public 匿名身份`)
  }
  // sub 用空串而非 null/undefined：aclFor → Qdrant ownerId match('') 不命中任何点，
  // 联合 public 条件后即「仅 public」语义（避免 undefined 值进过滤器）
  svcUser = { sub: '', role: 'member', dept: '' }
  return svcUser
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

// ---- 工具执行核心：与 MCP 协议层解耦，便于单测（mock store/qdrant/embedder）----
export async function handleToolCall(name, args = {}, { user, log = console } = {}) {
  const u = user ?? (await serviceUser(log))
  const def = TOOL_DEFS.find((d) => d.name === name)
  if (!def) return text(`未知工具 ${name}，可用工具: ${TOOL_DEFS.map((t) => t.name).join(' / ')}`, true)
  const invalid = validateSchema(args, def.inputSchema)
  if (invalid) return text(`参数校验失败: ${invalid}`, true)

  switch (name) {
    case 'rag_search': {
      const k = clamp(args.k, 1, 20, 5)
      const q = String(args.query)
      const vector = await embedOne(q)
      const acl = await aclFor(u) // ACL 下沉 Qdrant：public ∪ 本人 ∪ 同部门 ∪ 显式授权
      const { hits } = await hybridSearch({ text: q, vector, limit: k, docId: args.docId, acl, collection: activeCollection() })
      if (!hits.length) return text(`知识库中没有找到与「${q}」相关的资料。`)
      const body = hits
        .map(
          (h, i) =>
            `[${i + 1}] (相似度 ${h.score.toFixed(3)}) ${h.filename}${h.title ? ' · ' + h.title : ''}\n${h.text}`
        )
        .join('\n\n')
      return text(`检索到 ${hits.length} 条资料（混合检索）:\n\n${body}`)
    }
    case 'rag_list_docs': {
      const rows = u.role === 'admin' ? await listDocsAll() : await listDocsVisible(u.sub, u.dept)
      const limit = clamp(args.limit, 1, 100, 20)
      const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0)
      const page = rows.slice(offset, offset + limit)
      const lines = page.map(
        (d) =>
          `${d.id} · ${d.filename} · ${d.classification} · tags=${(d.tags ?? []).join(',') || '-'} · chunks=${d.chunks ?? '-'} · ${d.status}${d.error ? ` (${d.error})` : ''}`
      )
      return text(`共 ${rows.length} 篇可见文档，本页 ${page.length} 篇（offset=${offset}）:\n${lines.join('\n') || '（空）'}`)
    }
    case 'rag_doc_status': {
      const d = await getDoc(String(args.docId))
      // canReadDoc 唯一判定入口；不可读按 404 语义，不泄露文档存在性
      if (!d || !(await canReadDoc(u, d))) return text('文档不存在或无权访问')
      return text(
        JSON.stringify(
          {
            id: d.id,
            filename: d.filename,
            status: d.status,
            error: d.error ?? null,
            chunks: d.chunks,
            classification: d.classification,
            tags: d.tags ?? [],
            ownerId: d.user_id,
          },
          null,
          2
        )
      )
    }
    case 'rag_stats': {
      const rows = u.role === 'admin' ? await listDocsAll() : await listDocsVisible(u.sub, u.dept)
      const byStatus = rows.reduce((m, d) => ({ ...m, [d.status]: (m[d.status] ?? 0) + 1 }), {})
      const points = await countPoints(activeCollection())
      return text(`文档 ${rows.length} 篇（${Object.entries(byStatus).map(([s, n]) => `${s}:${n}`).join(' ') || '空'}），向量点 ${points} 个。`)
    }
    default:
      return text(`未知工具 ${name}`, true)
  }
}

// ---- Resources：rag://docs/{docId} → 全文（分块按 chunkIndex 排序拼回）----
const DOC_URI = /^rag:\/\/docs\/(.+)$/

export async function handleResourceRead(uri, { user, log = console } = {}) {
  const docId = DOC_URI.exec(uri)?.[1]
  if (!docId) throw new Error(`不支持的资源 URI: ${uri}`)
  const u = user ?? (await serviceUser(log))
  const d = await getDoc(docId)
  if (!d || !(await canReadDoc(u, d))) throw new Error(`资源不存在或无权访问: ${uri}`)
  const payloads = await scrollDocPoints(docId, 2000, d.collection)
  const textAll = payloads.map((p) => p.text).join('\n\n')
  return {
    contents: [{ uri, mimeType: 'text/plain', text: `# ${d.filename}\n\n${textAll}` }],
  }
}

// ---- 协议层组装：低层 Server（零 zod 依赖，inputSchema 直接用 JSON Schema）----
export function buildMcpServer({ log = console } = {}) {
  const server = new Server(
    { name: 'agentic-rag-kb', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = req.params.arguments ?? {}
    const sp = otelSpan(`mcp.tool.${name}`, 'TOOL', {
      'input.value': JSON.stringify(args),
      'langfuse.trace.name': `mcp.${name}`,
    })
    try {
      const out = await handleToolCall(name, args, { log })
      sp.end(out.content?.[0]?.text, out.isError ? { level: 'WARNING' } : {})
      return out
    } catch (e) {
      log.error?.(`[mcp] ${name} 执行失败: ${e.message}`)
      sp.end(e.message, { level: 'ERROR', statusMessage: e.message })
      return text(`工具执行失败: ${e.message}`, true)
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const u = await serviceUser(log)
    const rows = u.role === 'admin' ? await listDocsAll() : await listDocsVisible(u.sub, u.dept)
    return {
      resources: rows
        .filter((d) => d.status === 'ready') // 摄取完成的文档才可读全文
        .map((d) => ({ uri: `rag://docs/${d.id}`, name: d.filename, mimeType: 'text/plain' })),
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => handleResourceRead(req.params.uri, { log }))

  return server
}
