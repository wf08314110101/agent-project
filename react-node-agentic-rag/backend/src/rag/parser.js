// ============================================================================
// 文件解析层：把上传的原始文件统一转成纯文本，供后续切块
// ----------------------------------------------------------------------------
// 支持格式：
//   - pdf  : pdf-parse（提取文本层，扫描件无文本则解析结果为空）
//   - docx : mammoth extractRawText（忽略样式，只取正文）
//   - 文本类: md / markdown / txt / csv / json / html / log（html 额外剥标签）
// 其他：SHA-256 内容哈希，用于上传去重（内容级幂等）。
// ============================================================================

import crypto from 'node:crypto'
import { extractRawText } from 'mammoth'
// 直接引 lib 内部入口，绕开 pdf-parse 的测试文件副作用（其 index.js 会读 ./test 目录）
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

// 纯文本类扩展名（按 utf8 直接读取）
const TXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'log'])
// 对外允许上传的完整集合 = 文本类 + pdf + docx
export const ACCEPT_EXT = new Set([...TXT_EXT, 'pdf', 'docx'])

/**
 * 计算内容哈希（SHA-256）：
 * 上传时用于内容级去重——同一份文件即使改了文件名也不会被重复摄取。
 */
export const hashBuffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/**
 * 按扩展名分发解析器，把文件 Buffer 转成纯文本
 * @param {string} filename - 原始文件名（取扩展名判断类型）
 * @param {Buffer} buffer   - 文件内容
 * @returns {Promise<string>} 清洗后的纯文本
 * @throws 不支持的扩展名时抛错（worker 会把文档标记为 failed）
 */
export async function parseFile(filename, buffer) {
  const ext = filename.toLowerCase().split('.').pop() // 取最后一个扩展名
  if (ext === 'pdf') return clean((await pdfParse(buffer)).text)
  if (ext === 'docx') return clean((await extractRawText({ buffer })).value)
  if (TXT_EXT.has(ext)) {
    const raw = buffer.toString('utf8')
    // html/htm 先剥掉 script/style/标签，其余文本类直接使用
    return clean(ext === 'html' || ext === 'htm' ? stripHtml(raw) : raw)
  }
  throw new Error(`不支持的文件类型: .${ext}`)
}

/**
 * 文本清洗：统一换行符为 \n、压缩 3 个以上连续空行为 2 个、去掉首尾空白
 * 目的：让切块阶段的空行分段（\n{2,}）行为稳定。
 */
const clean = (t) => t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/**
 * 剥离 HTML：依次移除 script 块、style 块、所有标签，最后还原 &nbsp;
 * 顺序很重要：先删 script/style 再删普通标签，避免残留内嵌 JS/CSS 文本。
 */
const stripHtml = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
