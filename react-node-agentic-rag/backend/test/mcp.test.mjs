// ============================================================================
// MCP Server 单元测试（node:test）：工具执行核心 / 参数校验 / ACL 同源 / 资源读取
// 运行：npm test（node --test --experimental-test-module-mocks）
// ----------------------------------------------------------------------------
// mock.module 桩掉 pg/qdrant/embedder/otel 依赖（acl.js 走真实实现），
// 验证 handleToolCall 的分发、校验、格式化与 404 语义（不泄露文档存在性）。
// ============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

// --- 桩数据（namedExports 引用闭包，测试内可切换场景）---
const stub = {
  users: new Map(),      // id → user 行
  docs: new Map(),       // id → documents 行
  grants: new Map(),     // uid → [docId]
  searchCalls: [],       // hybridSearch 调用记录
  searchHits: [],        // hybridSearch 返回
  pointsCount: 42,
  visibleRows: [],
  allRows: [],
  scrolled: [],
}

mock.module('../src/store/pg.js', {
  namedExports: {
    getUserByName: async (name) => [...stub.users.values()].find((u) => u.username === name),
    getUserById: async (id) => stub.users.get(id),
    listGrantsForUser: async (uid) => (stub.grants.get(uid) ?? []).map((doc_id) => ({ doc_id })),
    listDocsVisible: async (userId, dept) => {
      stub.lastVisible = { userId, dept }
      return stub.visibleRows
    },
    listDocsAll: async () => stub.allRows,
    getDoc: async (id) => stub.docs.get(id),
  },
})

mock.module('../src/rag/qdrant.js', {
  namedExports: {
    hybridSearch: async (args) => {
      stub.searchCalls.push(args)
      return { mode: 'hybrid-rrf', hits: stub.searchHits }
    },
    countPoints: async () => stub.pointsCount,
    scrollDocPoints: async () => stub.scrolled,
  },
})

mock.module('../src/rag/embedder.js', {
  namedExports: {
    embedOne: async () => [0.1, 0.2],
    embed: async () => [[0.1, 0.2]],
  },
})

mock.module('../src/obs/otel.js', {
  namedExports: {
    otelSpan: () => ({ setAttr: () => {}, end: () => {} }),
  },
})

// M17：registry 桩掉（切断 domain → ingest → pg/qdrant 真实依赖链，MCP 核心测试不需要领域包）
mock.module('../src/domain/registry.js', {
  namedExports: {
    domainToolDefs: [],
    domainHandlers: {},
    activeCollection: () => 'test_collection',
    packs: [],
    applyDomain: async () => {},
  },
})

const { handleToolCall, handleResourceRead, TOOL_DEFS } = await import('../src/mcp/mcp-server.js')

const D = (over = {}) => ({ id: 'd1', user_id: 'm1', classification: 'public', status: 'ready', filename: 'crag.pdf', chunks: 3, tags: [], ...over })
const H = (over = {}) => ({ score: 0.82, docId: 'd1', chunkIndex: 0, filename: 'crag.pdf', text: 'CRAG 是一种检索增强范式…', ...over })

beforeEach(() => {
  stub.users.clear()
  stub.docs.clear()
  stub.grants.clear()
  stub.searchCalls = []
  stub.searchHits = []
  stub.visibleRows = []
  stub.allRows = []
  stub.scrolled = []
})
afterEach(() => mock.resetAll?.())

// ============================================================================
// rag_search
// ============================================================================
describe('rag_search', () => {
  it('走 embed → hybridSearch，ACL 为匿名 member（仅 public，grants 空）', async () => {
    stub.searchHits = [H()]
    const out = await handleToolCall('rag_search', { query: '什么是 CRAG' })
    assert.equal(out.isError, undefined)
    assert.equal(stub.searchCalls.length, 1)
    const call = stub.searchCalls[0]
    assert.equal(call.text, '什么是 CRAG')
    assert.equal(call.limit, 5)
    assert.deepEqual(call.acl, { userId: '', role: 'member', dept: '', grants: [] })
    assert.match(out.content[0].text, /crag\.pdf/)
    assert.match(out.content[0].text, /相似度 0\.820/)
  })

  it('k 超界被夹紧到 20', async () => {
    await handleToolCall('rag_search', { query: 'x', k: 50 })
    assert.equal(stub.searchCalls[0].limit, 20)
  })

  it('无命中返回友好提示（非 error）', async () => {
    const out = await handleToolCall('rag_search', { query: '不存在的内容' })
    assert.match(out.content[0].text, /没有找到/)
    assert.equal(out.isError, undefined)
  })

  it('缺 query 触发参数校验失败（isError）', async () => {
    const out = await handleToolCall('rag_search', {})
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /参数校验失败/)
  })
})

// ============================================================================
// rag_list_docs / rag_stats：匿名身份走 listDocsVisible
// ============================================================================
describe('rag_list_docs / rag_stats', () => {
  it('列表：匿名走 listDocsVisible(null, "")', async () => {
    stub.visibleRows = [D()]
    const out = await handleToolCall('rag_list_docs', {})
    assert.deepEqual(stub.lastVisible, { userId: '', dept: '' })
    assert.match(out.content[0].text, /共 1 篇可见文档/)
    assert.match(out.content[0].text, /crag\.pdf/)
  })

  it('stats：文档数 + 向量点数', async () => {
    stub.visibleRows = [D(), D({ id: 'd2', status: 'pending' })]
    const out = await handleToolCall('rag_stats', {})
    assert.match(out.content[0].text, /文档 2 篇/)
    assert.match(out.content[0].text, /ready:1 pending:1/)
    assert.match(out.content[0].text, /向量点 42 个/)
  })
})

// ============================================================================
// rag_doc_status：canReadDoc 同源判定，不可读按 404 语义
// ============================================================================
describe('rag_doc_status', () => {
  it('public 文档可读，返回状态 JSON', async () => {
    stub.docs.set('d1', D())
    const out = await handleToolCall('rag_doc_status', { docId: 'd1' })
    const meta = JSON.parse(out.content[0].text)
    assert.equal(meta.status, 'ready')
    assert.equal(meta.classification, 'public')
  })

  it('private 文档对匿名不可读 → 404 语义（不泄露存在性）', async () => {
    stub.docs.set('d1', D({ classification: 'private' }))
    const out = await handleToolCall('rag_doc_status', { docId: 'd1' })
    assert.equal(out.content[0].text, '文档不存在或无权访问')
  })

  it('不存在的文档同样返回 404 语义', async () => {
    const out = await handleToolCall('rag_doc_status', { docId: 'ghost' })
    assert.equal(out.content[0].text, '文档不存在或无权访问')
  })
})

// ============================================================================
// 资源读取 / 工具清单
// ============================================================================
describe('resources / defs', () => {
  it('读取 rag://docs/{id}：分块按 chunkIndex 拼回全文', async () => {
    stub.docs.set('d1', D())
    // mock.scrollDocPoints 直通（真实实现负责排序），这里按 chunkIndex 升序给桩
    stub.scrolled = [{ text: '第一段', chunkIndex: 0 }, { text: '第二段', chunkIndex: 1 }]
    const out = await handleResourceRead('rag://docs/d1')
    assert.match(out.contents[0].text, /第一段\n\n第二段/)
    assert.equal(out.contents[0].mimeType, 'text/plain')
  })

  it('非法 URI / 不可读资源抛错', async () => {
    await assert.rejects(() => handleResourceRead('file:///etc/passwd'), /不支持的资源 URI/)
    stub.docs.set('d1', D({ classification: 'private' }))
    await assert.rejects(() => handleResourceRead('rag://docs/d1'), /不存在或无权访问/)
  })

  it('TOOL_DEFS 清单完整且 schema 含 required', () => {
    assert.deepEqual(TOOL_DEFS.map((t) => t.name), ['rag_search', 'rag_list_docs', 'rag_doc_status', 'rag_stats'])
    assert.deepEqual(TOOL_DEFS[0].inputSchema.required, ['query'])
  })

  it('未知工具返回 isError 与可用工具清单', async () => {
    const out = await handleToolCall('no_such_tool', {})
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /rag_search \/ rag_list_docs/)
  })
})
