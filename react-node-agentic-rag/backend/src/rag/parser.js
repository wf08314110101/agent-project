// ============================================================================
// 文件解析层（M19 注册表模式）：registerParser(ext, fn) 按扩展名注册解析器，
// 与 chunker/prompt 注册表同风格——内核只认接口，新格式零侵入扩展。
// ----------------------------------------------------------------------------
// 内置解析器：
//   - pdf  : pdfjs-dist 提取文本层（与 pdf-parse 同源引擎）；扫描件（字符密度过低）
//            逐页渲染 PNG → 视觉模型 OCR，页间拼 `## 第 N 页`
//   - docx : mammoth convertToHtml（保标题/表格结构）+ 内嵌图片 OCR（行内【图：…】）
//   - 图片 : png/jpg/jpeg/webp 直接视觉转录（截图/表格/票据）
//   - 文本类: md / markdown / txt / csv / json / html / log（html 转文本保结构）
// zip 不在此解析——上传路由层解压为多个独立文档。
// 其他：SHA-256 内容哈希，用于上传去重（内容级幂等）。
// ============================================================================

import crypto from 'node:crypto'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs' // legacy 构建 = Node 兼容（无 DOM 依赖）
import { createCanvas } from '@napi-rs/canvas'                // 预编译 napi 原生 canvas，零编译依赖
import { config } from '../config.js'
import { ocrEnabled, ocrImage } from './ocr.js'

// 纯文本类扩展名（按 utf8 直接读取）
const TXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'log'])
// 图片扩展名 → MIME（视觉转录）
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
// zip 在上传路由层解压，不进解析器
export const ACCEPT_EXT = new Set([...TXT_EXT, 'pdf', 'docx', ...Object.keys(IMG_MIME), 'zip'])
export const IMG_EXT = new Set(Object.keys(IMG_MIME))

// 解析器注册表：ext → (buffer, log) => Promise<text>
const parsers = new Map()
export function registerParser(ext, fn) {
  parsers.set(String(ext).toLowerCase(), fn)
}

/**
 * 计算内容哈希（SHA-256）：
 * 上传时用于内容级去重——同一份文件即使改了文件名也不会被重复摄取。
 */
export const hashBuffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------------------
// PDF：文本层优先，扫描件降级 OCR
// ---------------------------------------------------------------------------

// 扫描件判定阈值：每页文本层字符数低于该值视为扫描件（正常页面远高于此）
const SCAN_DENSITY = 100
// 页面渲染缩放（1 = 72dpi；2 = 144dpi，兼顾 OCR 识别率与图片体积/成本）
const RENDER_SCALE = 2

async function parsePdf(buffer, log) {
  const loadingTask = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false })
  const pdf = await loadingTask.promise
  try {
    // 1) 提取文本层
    const pages = []
    let chars = 0
    for (let i = 1; i <= pdf.numPages; i++) {
      const { items } = await (await pdf.getPage(i)).getTextContent()
      const t = items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim()
      chars += t.length
      pages.push(t)
    }
    const layerText = pages.join('\n\n')
    // 2) 文本层密度过低 = 扫描件：OCR 开启则逐页渲染 → 视觉转录；未开启则降级返回空文本层（不阻断）
    if (chars >= pdf.numPages * SCAN_DENSITY || !ocrEnabled()) {
      if (chars < pdf.numPages * SCAN_DENSITY) log?.warn?.('[parser] PDF 无有效文本层且 OCR 未启用，仅返回空文本层')
      return layerText
    }
    const limit = Math.min(pdf.numPages, config.ocr.maxPages) // 成本闸
    const out = []
    for (let i = 1; i <= limit; i++) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: RENDER_SCALE })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
      const text = await ocrImage(canvas.toBuffer('image/png'), 'image/png')
      out.push(`## 第 ${i} 页\n\n${text}`)
    }
    let text = out.join('\n\n')
    if (pdf.numPages > limit) text += `\n\n（扫描件超过 OCR 页数上限 ${config.ocr.maxPages}，仅转录前 ${limit} 页）`
    return text
  } finally {
    await loadingTask.destroy().catch(() => { }) // 释放 worker/内存（destroy 在 loadingTask 上）
  }
}

// ---------------------------------------------------------------------------
// docx：结构化 HTML + 内嵌图 OCR
// ---------------------------------------------------------------------------

async function parseDocx(buffer) {
  // 自定义图片转换：图片字节收集到数组，正文里留占位符（mammoth 默认会丢弃图片）
  const images = []
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        images.push({ buf: await image.readAsBuffer(), mime: image.contentType })
        return { src: `__OCR_IMG_${images.length - 1}__` }
      }),
    },
  )
  // OCR 占位图（同步 replace 无法 await，先转录再整体替换）；超限/未启用/失败的图直接丢弃
  const texts = new Map()
  if (ocrEnabled()) {
    const slots = [...new Set([...html.matchAll(/__OCR_IMG_(\d+)__/g)].map((m) => Number(m[1])))]
      .sort((a, b) => a - b)
      .slice(0, config.ocr.maxImages)
    for (const i of slots) texts.set(i, await ocrImage(images[i].buf, images[i].mime))
  }
  // 替换整个 <img> 标签（占位符在 src 属性里，只换属性会被随后的剥标签步骤吞掉）；
  // 超限/未启用/失败的图直接丢弃
  return htmlToText(html.replace(/<img[^>]*__OCR_IMG_(\d+)__[^>]*>/g, (_, n) => {
    const t = texts.get(Number(n))
    return t ? `【图：${t}】` : ''
  }))
}

// ---------------------------------------------------------------------------
// 文本类与图片
// ---------------------------------------------------------------------------

const parseText = (ext) => async (buffer) =>
  ext === 'html' || ext === 'htm' ? htmlToText(buffer.toString('utf8')) : buffer.toString('utf8')

for (const ext of TXT_EXT) registerParser(ext, parseText(ext))
for (const [ext, mime] of Object.entries(IMG_MIME))
  registerParser(ext, async (buffer) => (ocrEnabled() ? await ocrImage(buffer, mime) : ''))
registerParser('pdf', parsePdf)
registerParser('docx', parseDocx)

/**
 * 按扩展名分发解析器，把文件 Buffer 转成纯文本
 * @param {string} filename - 原始文件名（取扩展名判断类型）
 * @param {Buffer} buffer   - 文件内容
 * @param {object} [log]    - 可选日志实例（Fastify log，扫描件降级等场景打 warn）
 * @returns {Promise<string>} 清洗后的纯文本
 * @throws 未注册的扩展名时抛错（worker 会把文档标记为 failed）
 */
export async function parseFile(filename, buffer, log) {
  const ext = filename.toLowerCase().split('.').pop() // 取最后一个扩展名
  const fn = parsers.get(ext)
  if (!fn) throw new Error(`不支持的文件类型: .${ext}`)
  return clean(await fn(buffer, log))
}

/**
 * 文本清洗：统一换行符为 \n、压缩 3 个以上连续空行为 2 个、去掉首尾空白
 * 目的：让切块阶段的空行分段（\n{2,}）行为稳定。
 */
const clean = (t) => t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/**
 * HTML → 文本（M19 升级：比裸剥标签多保留结构信号）
 * 标题 h1-h6 → Markdown 井号；表格单元格 → ` | `、行尾换行；列表 → `- `；块级标签 → 换行。
 * 顺序很重要：先删 script/style 再处理其余标签，避免残留内嵌 JS/CSS 文本。
 */
const htmlToText = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, '') // 开标签去空格，配合 ' | ' 单元格分隔
    .replace(/<\/?(p|div|ul|ol|table|thead|tbody|tr|h[1-6]|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
