// ============================================================================
// M19 fixture 生成器：产出评测用多格式样例（无人工素材依赖，全脚本生成）
//   - evals/fixtures/设备巡检操作规程-扫描版.pdf : 文本渲染成图 → JPEG → 手工封装 PDF（无文本层扫描件）
//   - evals/fixtures/服务器采购验收单.docx      : 手工封装 OOXML zip（正文 + 内嵌 PNG 表格图）
//   - evals/fixtures/运维值班表-截图.png        : canvas 直绘表格截图
// 事实与 golden-core 追加题一一对应；图片尺寸（PNG IHDR）是 mock VLM 区分转录内容的键。
// 运行：node scripts/gen-m19-fixtures.mjs
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'evals/fixtures')
mkdirSync(OUT, { recursive: true })

// canvas 需用 GlobalFonts 可见的字体族（PingFang SC 不在 @napi-rs/canvas 字体表，会渲染豆腐块）
const FONT = '26px "Hiragino Sans GB", "Songti SC", "Heiti TC", sans-serif'

// 画布上写多行文本
function drawLines(lines, width, height) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#111'
  ctx.font = FONT
  let y = 60
  for (const line of lines) {
    ctx.fillText(line, 50, y)
    y += line === '' ? 24 : 44
  }
  return canvas
}

// ---- 1. 扫描版 PDF：canvas → JPEG → 手工封装单页 PDF（DCTDecode，无文本层）----
const SCAN_LINES = [
  '设备巡检操作规程（扫描版）',
  '',
  '第五条 机房巡检频次：核心机柜每小时记录一次温度与湿度。',
  '第六条 UPS 电量低于 30% 触发一级告警，值班人员须在 15 分钟内到场处置。',
  '第七条 巡检异常须填写工单并同步值班群，夜间联系电话 021-6688。',
]
const scanCanvas = drawLines(SCAN_LINES, 1190, 1680) // 渲染 PNG 尺寸 1190x1680（= 595x840pt × scale2）

async function jpegPdf() {
  const jpeg = await scanCanvas.encode('jpeg', 0.85)
  const W = 595, H = 840, IW = 1190, IH = 1680
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`
  const parts = []
  let pos = 0
  const offsets = []
  const push = (s) => { parts.push(Buffer.from(s, 'latin1')); pos += Buffer.byteLength(s, 'latin1') }
  const mark = (i) => { offsets[i] = pos }
  push('%PDF-1.4\n')
  mark(1); push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  mark(2); push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  mark(3); push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`)
  mark(4); push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${IW} /Height ${IH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)
  parts.push(jpeg); pos += jpeg.length
  push('\nendstream\nendobj\n')
  mark(5); push(`5 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`)
  const xref = pos
  push(`xref\n0 6\n0000000000 65535 f \n`)
  for (let i = 1; i <= 5; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}

// ---- 2. 手工封装 zip（store 模式，node:zlib crc32）----
function zipStore(files) {
  const local = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name)
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    local.push(lh, nameBuf, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuf, eocd])
}

// ---- 3. 含图 docx：正文段落 + 内嵌 PNG（1100x620）----
const DOCX_IMG_LINES = [
  '服务器采购资产清单',
  '',
  '型号：RS720-E9-RS8，数量 3 台，单价 42800 元',
  '上架机房：浦东 B2-07，验收结论：全部通过',
]
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

function makeDocx(png) {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R}" xmlns:wp="${WP}">
<w:body>
<w:p><w:r><w:t>服务器采购验收单</w:t></w:r></w:p>
<w:p><w:r><w:t>验收日期：2026-09-18，验收人：王强。资产明细见下图。</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3093760"/><wp:docPr id="1" name="img1"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="img1"/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="3093760"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body></w:document>`
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId0" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`) },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R}/image" Target="media/image1.png"/>
</Relationships>`) },
    { name: 'word/media/image1.png', data: png },
  ])
}

// ---- 生成 ----
const dutyCanvas = drawLines([
  '9 月运维值班表（截图）',
  '',
  '周一 张伟    周二 李娜    周三 王强',
  '周四 刘洋    周五 陈静    夜间电话 021-9527',
], 900, 520)

const docxPng = drawLines(DOCX_IMG_LINES, 1100, 620) // PNG 尺寸 1100x620 = mock VLM 的内容键

writeFileSync(join(OUT, '设备巡检操作规程-扫描版.pdf'), await jpegPdf())
writeFileSync(join(OUT, '服务器采购验收单.docx'), makeDocx(await docxPng.encode('png')))
writeFileSync(join(OUT, '运维值班表-截图.png'), await dutyCanvas.encode('png'))
console.log('M19 fixtures 已生成 →', OUT)
