// ============================================================================
// RBAC 单元测试（node:test）：密级判定 / 标签清洗 / 检索 ACL 组装
// 运行：node --test --experimental-test-module-mocks backend/test/acl.test.mjs
// ----------------------------------------------------------------------------
// sanitizeTags 为纯函数直接测；canReadDoc / aclFor 通过 mock.module 桩掉
// sqlite 依赖（getUserById / listGrantsForUser）后验证判定逻辑。
// ============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

// --- 桩数据：模拟 users 表与 doc_grants 表的子集 ---
// users: { id → { dept } }；grants: { uid → [docId,...] }
// 桩值固定、状态可变：namedExports 引用闭包函数，测试内改 stub.map 即可切换场景
const stub = { users: new Map(), grants: new Map() }

// mock.module 必须在 acl.js 首次 import 之前注册（需 --experimental-test-module-mocks）
mock.module('../src/store/sqlite.js', {
  namedExports: {
    getUserById: { get: (id) => stub.users.get(id) },
    listGrantsForUser: { all: (uid) => (stub.grants.get(uid) ?? []).map((doc_id) => ({ doc_id })) },
  },
})

const { canReadDoc, aclFor, sanitizeTags, CLASSIFICATIONS, TAG_WHITELIST } = await import('../src/acl.js')

const U = {
  admin: { sub: 'a1', role: 'admin', dept: '研发' },
  memberR: { sub: 'm1', role: 'member', dept: '研发' },   // 即 D() 默认 owner
  memberR2: { sub: 'm9', role: 'member', dept: '研发' },  // 同部门他人
  memberS: { sub: 'm2', role: 'member', dept: '销售' },
  memberNoDept: { sub: 'm3', role: 'member', dept: '' },
}

const D = (over = {}) => ({
  id: 'd1', user_id: 'm1', classification: 'public', ...over,
})

beforeEach(() => { stub.users.clear(); stub.grants.clear() })
afterEach(() => mock.resetAll?.())

// ============================================================================
// sanitizeTags：白名单过滤 + 去重 + 容错
// ============================================================================
describe('sanitizeTags', () => {
  it('白名单内标签保留', () => {
    assert.deepEqual(sanitizeTags(['技术方案', '运维']), ['技术方案', '运维'])
  })
  it('去重', () => {
    assert.deepEqual(sanitizeTags(['运维', '运维', '制度']), ['运维', '制度'])
  })
  it('白名单外标签丢弃', () => {
    assert.deepEqual(sanitizeTags(['技术方案', '机密', 'xxx']), ['技术方案'])
  })
  it('逗号字符串输入', () => {
    assert.deepEqual(sanitizeTags('技术方案, 运维 , 未知'), ['技术方案', '运维'])
  })
  it('空输入返回空数组', () => {
    assert.deepEqual(sanitizeTags(undefined), [])
    assert.deepEqual(sanitizeTags(''), [])
    assert.deepEqual(sanitizeTags([]), [])
  })
})

// ============================================================================
// canReadDoc：密级判定单点
// ============================================================================
describe('canReadDoc', () => {
  beforeEach(() => {
    // owner m1 属研发部
    stub.users.set('m1', { dept: '研发' })
  })

  it('admin 全通', () => {
    assert.equal(canReadDoc(U.admin, D({ classification: 'private', user_id: 'm1' })), true)
  })
  it('owner 总可读自己的私有文档', () => {
    assert.equal(canReadDoc(U.memberR, D({ classification: 'private', user_id: 'm1' })), true)
  })
  it('public 全体登录用户可读', () => {
    assert.equal(canReadDoc(U.memberS, D({ classification: 'public', user_id: 'm1' })), true)
    assert.equal(canReadDoc(U.memberNoDept, D({ classification: 'public' })), true)
  })
  it('dept 同部门可读，跨部门不可读', () => {
    assert.equal(canReadDoc(U.memberR, D({ classification: 'dept', user_id: 'm1' })), true)
    assert.equal(canReadDoc(U.memberS, D({ classification: 'dept', user_id: 'm1' })), false)
  })
  it('dept 当 owner 无部门时无人可读（防泄露）', () => {
    stub.users.set('m1', { dept: '' })
    assert.equal(canReadDoc(U.memberR2, D({ classification: 'dept', user_id: 'm1' })), false)
  })
  it('private 仅 owner + 显式授权', () => {
    assert.equal(canReadDoc(U.memberS, D({ classification: 'private', user_id: 'm1' })), false)
    stub.grants.set('m2', ['d1']) // 授权给销售 m2
    assert.equal(canReadDoc(U.memberS, D({ id: 'd1', classification: 'private', user_id: 'm1' })), true)
  })
  it('授权对 dept 密级也生效（只增不减）', () => {
    stub.grants.set('m2', ['d1'])
    assert.equal(canReadDoc(U.memberS, D({ id: 'd1', classification: 'dept', user_id: 'm1' })), true)
  })
  it('null 输入返回 false', () => {
    assert.equal(canReadDoc(null, D()), false)
    assert.equal(canReadDoc(U.memberR, null), false)
  })
})

// ============================================================================
// aclFor：检索过滤组装
// ============================================================================
describe('aclFor', () => {
  it('admin 跳过过滤', () => {
    assert.deepEqual(aclFor(U.admin), { userId: 'a1', role: 'admin', dept: '研发' })
  })
  it('member 含部门与授权 docId 集合', () => {
    stub.grants.set('m1', ['d1', 'd2'])
    const a = aclFor(U.memberR)
    assert.equal(a.role, 'member')
    assert.equal(a.dept, '研发')
    assert.deepEqual(a.grants, ['d1', 'd2'])
  })
  it('member 无授权时 grants 为空数组', () => {
    const a = aclFor(U.memberNoDept)
    assert.deepEqual(a.grants, [])
    assert.equal(a.dept, '')
  })
  it('无用户上下文返回 null（脚本/评估不过滤）', () => {
    assert.equal(aclFor(null), null)
    assert.equal(aclFor(undefined), null)
  })
})

// ============================================================================
// 受控枚举完整性（防误删/漂移）
// ============================================================================
describe('受控枚举', () => {
  it('CLASSIFICATIONS 三级', () => {
    assert.deepEqual(CLASSIFICATIONS, ['public', 'dept', 'private'])
  })
  it('TAG_WHITELIST 覆盖预期标签', () => {
    for (const t of ['技术方案', '制度', '会议纪要', '运维', '竞品', '测试']) {
      assert.ok(TAG_WHITELIST.includes(t), `缺标签 ${t}`)
    }
  })
})
