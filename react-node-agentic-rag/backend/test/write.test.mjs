// ============================================================================
// M20 写能力单元测试（node:test）：幂等去重 / 审批两段式 / 执行收尾
// 运行：node --test --experimental-test-module-mocks backend/test/write.test.mjs
// ----------------------------------------------------------------------------
// pg / ingest-one 走 mock.module 桩（进程内 Map 状态），config 用真实模块
// （进程启动前置 WRITE_TOOLS=true），canWriteDoc 走真实 acl.js。
// ============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// 写工具开关必须在 config.js 首次加载前置好
process.env.WRITE_TOOLS = 'true'

// --- 进程内桩状态：approvals / staging_files / documents（版本组定位用）最小子集 ---
const stub = { approvals: new Map(), staging: new Map(), docs: new Map(), ingestCalls: [], nextId: 1 }

mock.module('../src/store/pg.js', {
  namedExports: {
    // acl.js 依赖
    getUserById: async () => undefined,
    listGrantsForUser: async () => [],
    // 写工具依赖
    insertApproval: async (id, sessionId, userId, tool, args, idemKey, expiresAt) => {
      for (const a of stub.approvals.values()) {
        if (a.idem_key === idemKey && ['pending', 'executed'].includes(a.status)) {
          return { approval: a, created: false }
        }
      }
      const row = { id, session_id: sessionId, user_id: userId, tool, args, idem_key: idemKey, status: 'pending', result: null, error: null, expires_at: expiresAt }
      stub.approvals.set(id, row)
      return { approval: row, created: true }
    },
    getApproval: async (id) => stub.approvals.get(id) ?? null,
    setApprovalStatus: async (status, result, error, id) => {
      const a = stub.approvals.get(id)
      if (a) { a.status = status; a.result = result; a.error = error }
    },
    getStagingFile: async (id) => stub.staging.get(id) ?? null,
    deleteStagingFile: async (id) => stub.staging.delete(id),
    // 版本组定位（写权限预检用）：key = `${collection}|${docKey}`
    getLatestDocByKey: async (collection, docKey) => stub.docs.get(`${collection}|${docKey}`) ?? null,
  },
})

// registry 整体桩掉：切断 domain → ingest → pg/qdrant 真实依赖链（本测试只需集合白名单）
mock.module('../src/domain/registry.js', {
  namedExports: {
    allowedCollections: () => new Set(['agentic_docs']),
  },
})

// ingestOne 桩：可热替换的 fn（测试内切换成功/失败场景）
const ingestStub = {
  fn: async (input) => {
    stub.ingestCalls.push(input)
    return { doc: { id: 'new1', filename: input.filename, status: 'pending', docVersion: 1, collection: 'agentic_docs', docKey: input.filename, replaced: null } }
  },
}
mock.module('../src/rag/ingest-one.js', {
  namedExports: {
    ingestOne: (input) => ingestStub.fn(input),
  },
})

const { interceptWrite, executeWrite, computeIdemKey, isWriteTool, WRITE_TOOLS } = await import('../src/agent/write.js')
const { config } = await import('../src/config.js')

const U = { sub: 'm1', username: 'alice', role: 'member', dept: '研发' }
const EMIT = { events: [], emit: (ev, d) => EMIT.events.push([ev, d]) }

beforeEach(async () => {
  stub.approvals.clear()
  stub.staging.clear()
  stub.docs.clear()
  stub.ingestCalls.length = 0
  config.write.autoApprove = false
  config.write.enabled = true
})
afterEach(async () => {
  for (const s of stub.staging.values()) await fs.rm(s.path, { force: true }).catch(() => {})
  mock.resetAll?.()
})

// 造一个真实暂存文件（computeIdemKey / executeWrite 都要读盘）
async function makeStaging(userId = U.sub, content = 'hello M20') {
  const id = `st-${stub.nextId++}`
  const p = path.join(os.tmpdir(), `m20-${id}.md`)
  await fs.writeFile(p, content)
  stub.staging.set(id, { id, user_id: userId, filename: `${id}.md`, size: content.length, path: p })
  return id
}
const ARGS = (stagingId, over = {}) => ({ stagingId, filename: '制度v2.md', docKey: '制度', summary: '提交新制度', ...over })

describe('isWriteTool（配置门控）', () => {
  it('WRITE_TOOLS 开启时识别写工具', () => {
    assert.equal(isWriteTool('submit_document'), true)
    assert.equal(WRITE_TOOLS.has('submit_document'), true)
  })
  it('WRITE_TOOLS 关闭时不识别（零破坏面）', () => {
    config.write.enabled = false
    assert.equal(isWriteTool('submit_document'), false)
    config.write.enabled = true
  })
})

describe('computeIdemKey', () => {
  it('同用户同目标同内容 → 键稳定；内容变化 → 键变化', async () => {
    const sid = await makeStaging(U.sub, 'v1 内容')
    const k1 = await computeIdemKey(U.sub, ARGS(sid), stub.staging.get(sid).path)
    const k2 = await computeIdemKey(U.sub, ARGS(sid), stub.staging.get(sid).path)
    assert.equal(k1, k2)
    await fs.writeFile(stub.staging.get(sid).path, 'v2 内容')
    const k3 = await computeIdemKey(U.sub, ARGS(sid), stub.staging.get(sid).path)
    assert.notEqual(k1, k3)
  })
  it('不同用户同内容 → 键不同', async () => {
    const sid = await makeStaging(U.sub)
    const k1 = await computeIdemKey(U.sub, ARGS(sid), stub.staging.get(sid).path)
    const k2 = await computeIdemKey('m2', ARGS(sid), stub.staging.get(sid).path)
    assert.notEqual(k1, k2)
  })
})

describe('interceptWrite：拦截与审批两段式', () => {
  it('stagingId 缺失/他人文件 → 拒绝且不落审批单', async () => {
    const o1 = await interceptWrite({ name: 'submit_document', args: { filename: 'x.md' }, user: U, ...EMIT })
    assert.match(o1, /不存在/)
    const other = await makeStaging('m2')
    const o2 = await interceptWrite({ name: 'submit_document', args: ARGS(other), user: U, ...EMIT })
    assert.match(o2, /不属于当前用户/)
    assert.equal(stub.approvals.size, 0)
  })

  it('正常路径：落 pending 审批单 + 发 approval_required + Observation 等待审批', async () => {
    const sid = await makeStaging()
    const events = []
    const obs = await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, emit: (ev, d) => events.push([ev, d]) })
    assert.equal(stub.approvals.size, 1)
    const [ap] = stub.approvals.values()
    assert.equal(ap.status, 'pending')
    assert.equal(ap.user_id, U.sub)
    assert.match(obs, new RegExp(ap.id))
    assert.match(obs, /等待用户/)
    const required = events.find(([e]) => e === 'approval_required')
    assert.ok(required, '必须发 approval_required 事件')
    assert.equal(required[1].approvalId, ap.id)
    assert.equal(required[1].filename, '制度v2.md')
  })

  it('幂等：同键重复提交复用同一张 pending 单，不新建', async () => {
    const sid = await makeStaging()
    await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    const obs2 = await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    assert.equal(stub.approvals.size, 1)
    assert.match(obs2, /已存在/)
  })

  it('幂等：已执行的同键提交直接给结论（不重复执行）', async () => {
    const sid = await makeStaging()
    await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    const [ap] = stub.approvals.values()
    ap.status = 'executed'
    ap.result = { docId: 'd9' }
    const obs = await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    assert.match(obs, /已提交/)
    assert.match(obs, /d9/)
  })

  it('写权限预检：替换他人版本组拒绝且不落单；owner/admin 放行', async () => {
    const sid = await makeStaging()
    // 他人（m2）已占用「制度」版本组 → member m1 拒绝
    stub.docs.set('agentic_docs|制度', { id: 'd0', user_id: 'm2' })
    const o1 = await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    assert.match(o1, /无写入权限/)
    assert.equal(stub.approvals.size, 0)
    // owner 放行
    stub.docs.set('agentic_docs|制度', { id: 'd0', user_id: 'm1' })
    const o2 = await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    assert.match(o2, /审批单/)
    assert.equal(stub.approvals.size, 1)
    // admin 可替换他人版本组（用自己的暂存文件）
    stub.approvals.clear()
    const sidA = await makeStaging('a1')
    const o3 = await interceptWrite({
      name: 'submit_document', args: ARGS(sidA), user: { ...U, sub: 'a1', role: 'admin' }, ...EMIT,
    })
    assert.match(o3, /审批单/)
  })

  it('非法目标集合（未启用领域包）拒绝', async () => {
    const sid = await makeStaging()
    const obs = await interceptWrite({ name: 'submit_document', args: ARGS(sid, { collection: 'rag_hack' }), user: U, ...EMIT })
    assert.match(obs, /非法目标集合/)
    assert.equal(stub.approvals.size, 0)
  })
})

describe('executeWrite：审批执行收尾', () => {
  it('autoApprove 全链路：intercept 直接执行 → ingestOne 收到表单同形 fields → 单转 executed', async () => {
    config.write.autoApprove = true
    const sid = await makeStaging()
    const obs = await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    assert.equal(stub.ingestCalls.length, 1)
    const call = stub.ingestCalls[0]
    assert.equal(call.filename, '制度v2.md')
    assert.equal(call.fields.classification.value, 'private') // 缺省最小暴露面
    assert.equal(call.fields.docKey.value, '制度')
    assert.equal(call.user.sub, U.sub)
    const [ap] = stub.approvals.values()
    assert.equal(ap.status, 'executed')
    assert.equal(ap.result.docId, 'new1')
    assert.match(obs, /new1/)
    assert.equal(stub.staging.size, 0) // 暂存已清理
  })

  it('非 pending 单不可执行；暂存丢失 → failed 落档', async () => {
    assert.match((await executeWrite('nope', U)).error, /不可执行/)
    const sid = await makeStaging()
    await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
    const [ap] = stub.approvals.values()
    await fs.rm(stub.staging.get(sid).path, { force: true })
    stub.staging.delete(sid)
    const r = await executeWrite(ap.id, U)
    assert.match(r.error, /暂存文件不存在/)
    assert.equal(ap.status, 'failed')
  })

  it('ingestOne 报错 → 单转 failed 并回传 error', async () => {
    const orig = ingestStub.fn
    ingestStub.fn = async () => ({ code: 409, error: '旧版本正在摄取中' })
    try {
      const sid = await makeStaging()
      await interceptWrite({ name: 'submit_document', args: ARGS(sid), user: U, ...EMIT })
      const [ap] = stub.approvals.values()
      const r = await executeWrite(ap.id, U)
      assert.match(r.error, /摄取中/)
      assert.equal(ap.status, 'failed')
    } finally {
      ingestStub.fn = orig
    }
  })
})
