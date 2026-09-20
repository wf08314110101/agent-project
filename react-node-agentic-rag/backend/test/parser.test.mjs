// ============================================================================
// 解析层单元测试（node:test）：注册表分发 / 文本与 HTML 结构保留 / 图片与 docx OCR
// 运行：node --test --experimental-test-module-mocks backend/test/parser.test.mjs
// ----------------------------------------------------------------------------
// ocr.js 用 mock.module 桩掉（单测不依赖外部视觉模型）；docx 用例读 M19 生成的
// evals/fixtures/服务器采购验收单.docx（缺失则跳过）。
// ============================================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// OCR 桩：ocrEnabled=true，ocrImage 返回固定转录文本
mock.module('../src/rag/ocr.js', {
  namedExports: {
    ocrEnabled: () => true,
    ocrImage: async () => 'OCR转录文本',
  },
})

const { parseFile, registerParser, ACCEPT_EXT } = await import('../src/rag/parser.js')

const DOCX_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../evals/fixtures/服务器采购验收单.docx')

describe('parser 注册表', () => {
  it('按扩展名分发：txt 直读并清洗', async () => {
    assert.equal(await parseFile('a.txt', Buffer.from('你好\r\n\r\n\r\n\n世界  ')), '你好\n\n世界')
  })

  it('未注册扩展名抛错', async () => {
    await assert.rejects(() => parseFile('x.exe', Buffer.from('')), /不支持的文件类型/)
  })

  it('registerParser 可覆盖/新增解析器', async () => {
    registerParser('xyz', async () => '自定义解析')
    assert.equal(await parseFile('f.xyz', Buffer.from('')), '自定义解析')
  })

  it('ACCEPT_EXT 覆盖 M19 新格式（图片/zip）', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'zip']) assert.ok(ACCEPT_EXT.has(ext))
  })
})

describe('结构保留', () => {
  it('html：标题转井号、表格单元格转竖线', async () => {
    const t = await parseFile('p.html', Buffer.from('<h1>标题</h1><table><tr><td>甲</td><td>乙</td></tr></table>'))
    assert.ok(t.includes('# 标题'))
    assert.ok(t.includes('甲 | 乙'))
  })
})

describe('OCR 通路（mock）', () => {
  it('png 直接走视觉转录', async () => {
    assert.equal(await parseFile('img.png', Buffer.from('89504e47')), 'OCR转录文本')
  })

  it('docx：正文保留 + 内嵌图行内【图：…】', async (t) => {
    if (!existsSync(DOCX_FIXTURE)) return t.skip('需先运行 node scripts/gen-m19-fixtures.mjs')
    const text = await parseFile('服务器采购验收单.docx', readFileSync(DOCX_FIXTURE))
    assert.ok(text.includes('服务器采购验收单'))
    assert.ok(text.includes('【图：OCR转录文本】'))
  })
})
