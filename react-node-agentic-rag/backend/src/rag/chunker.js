// 结构感知切块：markdown 按标题分段（标题作为块上下文），普通文本按空行分段；贪心打包为 maxChars 窗口
const HEADING = /^(#{1,6})\s+(.+)$/

export function chunkText(text, { maxChars = 450, overlap = 60 } = {}) {
  const chunks = []
  for (const { title, body } of splitBlocks(text)) {
    const paras = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
    let buf = ''
    const flush = () => {
      if (buf.trim()) chunks.push({ title, text: buf.trim() })
      buf = ''
    }
    for (const p of paras) {
      if (p.length > maxChars) {
        flush()
        for (const piece of splitLong(p, maxChars, overlap)) chunks.push({ title, text: piece })
        continue
      }
      if (buf && (buf + '\n\n' + p).length > maxChars) flush()
      buf = buf ? buf + '\n\n' + p : p
    }
    flush()
  }
  return chunks.filter((c) => c.text.length > 10)
}

// 超长段落滑窗切断，尽量断在句号/换行处
function splitLong(p, maxChars, overlap) {
  const out = []
  let i = 0
  while (i < p.length) {
    let end = Math.min(p.length, i + maxChars)
    if (end < p.length) {
      const c = Math.max(p.lastIndexOf('。', end), p.lastIndexOf('\n', end))
      if (c > i + maxChars * 0.5) end = c + 1
    }
    out.push(p.slice(i, end).trim())
    if (end >= p.length) break
    i = Math.max(end - overlap, i + 1)
  }
  return out.filter(Boolean)
}

function splitBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let title = ''
  let buf = []
  const push = () => {
    const body = buf.join('\n').trim()
    if (body) blocks.push({ title, body })
    buf = []
  }
  for (const line of lines) {
    const m = line.match(HEADING)
    if (m) {
      push()
      title = m[2].trim()
    } else buf.push(line)
  }
  push()
  return blocks.length ? blocks : [{ title: '', body: text }]
}
