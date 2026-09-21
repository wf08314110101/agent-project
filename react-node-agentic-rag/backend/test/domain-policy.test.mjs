// ============================================================================
// M21 领域包② company-policy 单元测试：条款式切分器 + 描述符契约
// 运行：node --test backend/test/domain-policy.test.mjs
// ============================================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chunkPolicy } from '../src/domain/company-policy/chunker.js'
import pack from '../src/domain/company-policy/index.js'

const doc = `# 云枢科技考勤制度

> 附则说明：本制度自 2026-07-01 起施行。

## 第一章 总则

第1条 目的：规范出勤。

第2条 适用范围：全体员工。

## 第二章 考勤规则

第3条 工作时间为 9:00-18:00。

第4条 单笔超过 5000 元的报销需财务总监会签。
`

describe('company-policy 条款式切分（M21）', () => {
  it('按章分块：章边界强制断开，title 携带章名与条号区间', () => {
    const chunks = chunkPolicy(doc)
    const titles = chunks.map((c) => c.title)
    assert.ok(titles.some((t) => t.includes('第一章') && t.includes('1~2条')))
    assert.ok(titles.some((t) => t.includes('第二章') && t.includes('3~4条')))
    const ch1 = chunks.find((c) => c.title.includes('第一章'))
    assert.ok(ch1.text.includes('第1条') && ch1.text.includes('第2条'))
    assert.ok(!ch1.text.includes('第3条')) // 跨章不混块
  })

  it('条目原子性：一条内容完整落在同一块（不被拦腰截断）', () => {
    const hit = chunkPolicy(doc).find((c) => c.text.includes('5000'))
    assert.ok(hit, '含 5000 的块存在')
    assert.ok(hit.text.includes('财务总监会签'))
  })

  it('preamble（标题/引言）保留为独立块', () => {
    const chunks = chunkPolicy(doc)
    assert.ok(chunks[0].text.includes('2026-07-01'))
  })

  it('无条款结构的文本回退通用切分，不硬造块', () => {
    const chunks = chunkPolicy('A'.repeat(1000))
    assert.ok(chunks.length >= 1)
    assert.ok(!chunks.some((c) => /条/.test(c.title)))
  })

  it('单条超长降级滑窗拆分，title 加序号', () => {
    const chunks = chunkPolicy(`# 长制度\n\n第1条 ${'很长的条款内容。'.repeat(200)}\n`)
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every((c) => /1\(\d+\)/.test(c.title)))
  })
})

describe('company-policy 描述符契约（registry 消费）', () => {
  it('五件套可裁剪：无工具/无连接器，其余齐备', () => {
    assert.equal(pack.name, 'company-policy')
    assert.equal(pack.collection, 'rag_company_policy')
    assert.equal(typeof pack.chunker, 'function')
    assert.ok(pack.promptFragment.includes('条款号'))
    assert.ok(Array.isArray(pack.tagWhitelist) && pack.tagWhitelist.length > 0)
    assert.equal(pack.toolDefs, undefined)
    assert.equal(pack.connector, undefined)
  })
})
