// ============================================================================
// 领域切分策略（company-policy）：制度文本为"第X章/第X条"条款式结构，
// 通用滑窗常把一条拆成两半（如"超过 5000 元"与"需财务总监会签"分离，两半都不完整）
// ----------------------------------------------------------------------------
// 策略：条为原子单位——按「第X章」分段、「第X条」切条，章内条目贪心打包
//   （章边界强制分块，避免跨章语义混淆）；单条超长时才降级用内核 chunkText 滑窗兜底。
// maxChars 取 300（评测调参结论）：制度单条很短，整包塞多条会稀释单条事实的嵌入信号，
//   300 字 ≈ 2~4 条/块，粒度与召回实测最优。
// 诚实标注：条款正则覆盖中文制度惯例（第X章/第X条，含阿拉伯/汉字数字）；
//   无条款结构的文本自动回退通用切分，不硬造块。
// ============================================================================

import { chunkText } from '../../rag/chunker.js'

const RE_CHAPTER = /^(#{1,4}\s*)?(第[一二三四五六七八九十百零0-9]+章)\s*(.*)$/
const RE_ARTICLE = /^(#{1,4}\s*)?(第[一二三四五六七八九十百零0-9]+条)\s*(.*)$/
const MAX_CHARS = 300

export function chunkPolicy(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // 无条款结构：回退通用切分（参数化兜底，不硬造块）
  if (!lines.some((l) => RE_ARTICLE.test(l.trim()))) return chunkText(text, { maxChars: MAX_CHARS, overlap: 80 })

  const docTitle = lines.find((l) => /^#\s+/.test(l.trim()))?.replace(/^#\s+/, '').trim() ?? ''

  // 解析：preamble（标题/引言）+ blocks[]（章 + 条目，条内多行原样保留）
  const blocks = [] // { chapter, no, lines }
  let preamble = []
  let cur = null
  let chapter = ''
  for (const line of lines) {
    const t = line.trim()
    const mChap = t.match(RE_CHAPTER)
    const mArt = t.match(RE_ARTICLE)
    if (mChap) {
      chapter = `${mChap[2]}${mChap[3]?.trim() ? ' ' + mChap[3].trim() : ''}`
      cur = null // 章标题行不进块正文（由 title 携带），章边界即分块边界
      continue
    }
    if (mArt) {
      cur = { chapter, no: mArt[2], lines: [line] }
      blocks.push(cur)
      continue
    }
    if (/^#{1,4}\s+/.test(t)) continue // 其余 markdown 标题行：title 已携带，不进正文
    if (cur) cur.lines.push(line)
    else if (t) preamble.push(line)
  }

  const out = []
  if (preamble.length) out.push({ title: docTitle || '引言', text: preamble.join('\n').trim() })

  // 同章内贪心打包：条目短制度常见，多条同块保住"条款+上下文"完整性
  let pack = [] // 同章待合并条目
  const flush = () => {
    if (!pack.length) return
    const first = pack[0]
    const title = `${first.chapter || docTitle || '条款'} · ${pack.length > 1 ? `${strip(first.no)}~${strip(pack.at(-1).no)}条` : strip(first.no)}`
    const text = pack.flatMap((b) => b.lines).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length > MAX_CHARS) {
      // 单条超长（罕见）：滑窗兜底拆分，title 加序号
      chunkText(text, { maxChars: MAX_CHARS, overlap: 80 }).forEach((c, i) =>
        out.push({ title: `${title}(${i + 1})`, text: c.text })
      )
    } else {
      out.push({ title, text })
    }
    pack = []
  }
  for (const b of blocks) {
    if (b.chapter !== pack[0]?.chapter) flush() // 章边界强制分块
    pack.push(b)
  }
  flush()
  // 过短碎片丢弃（与内核 chunkText 同语义：无信息量块污染检索）
  return out.filter((c) => c.text.length > 10)
}

// 条号显示：第3条 → 3（保留原数字形态，仅去"第/条"外框）
const strip = (no) => String(no).replace(/^第/, '').replace(/条$/, '')
