// ============================================================================
// 结构感知切块：markdown 按标题分段（标题作为块上下文），普通文本按空行分段；贪心打包为 maxChars 窗口
// ----------------------------------------------------------------------------
// 分块策略（两级）：
//   1. splitBlocks：以 markdown 标题（# ~ ######）为界切大块，标题记为块的 title，
//      使每个内容块自带"所属章节"上下文（嵌入与回答引用都受益）；
//   2. chunkText：块内按空行拆段落，贪心打包段落直到 maxChars；超长段落单独走滑窗切断。
// 产出：[{ title, text }]，text 过短（<=10 字符）的碎片被丢弃。
// ============================================================================

// 匹配 1-6 级 markdown 标题：捕获组 2 为标题文字（如 "## 安装步骤" → "安装步骤"）
const HEADING = /^(#{1,6})\s+(.+)$/

/**
 * 主入口：把全文切为带标题上下文的块
 * @param {string} text - 解析后的纯文本
 * @param {object} opts
 *   - maxChars: 单块目标字符数上限（默认 450，与嵌入模型输入长度匹配）
 *   - overlap : 超长段落滑窗切断时的重叠字符数（默认 60，保证语义连续）
 * @returns {Array<{title: string, text: string}>}
 */
export function chunkText(text, { maxChars = 450, overlap = 60 } = {}) {
  const chunks = []
  // 外层：按标题分出的每个大块
  for (const { title, body } of splitBlocks(text)) {
    // 块内按空行（2 个以上换行）拆段落，压缩空白后滤掉空段
    const paras = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
    let buf = '' // 当前正在打包的窗口
    // flush：把当前窗口定稿为一个 chunk，然后清空
    const flush = () => {
      if (buf.trim()) chunks.push({ title, text: buf.trim() })
      buf = ''
    }
    for (const p of paras) {
      // 情况 1：单段超长 → 先定稿当前窗口，段落单独滑窗切断
      if (p.length > maxChars) {
        flush()
        for (const piece of splitLong(p, maxChars, overlap)) chunks.push({ title, text: piece })
        continue
      }
      // 情况 2：再塞进当前段会超限 → 先定稿，当前段开新窗口
      if (buf && (buf + '\n\n' + p).length > maxChars) flush()
      buf = buf ? buf + '\n\n' + p : p
    }
    flush() // 收尾：块内最后一个窗口
  }
  // 过滤过短碎片（无信息量，还会污染检索）
  return chunks.filter((c) => c.text.length > 10)
}

/**
 * 超长段落滑窗切断，尽量断在句号/换行处
 * 例：p 长度 1000，maxChars=450，overlap=60：
 *   第一刀 [0, 450] 内回溯最近的句号/换行作为切点；下一刀从 切点-60 开始。
 * @returns {string[]} 切出的片段列表
 */
function splitLong(p, maxChars, overlap) {
  const out = []
  let i = 0
  while (i < p.length) {
    let end = Math.min(p.length, i + maxChars)
    if (end < p.length) {
      // 未到末尾：在窗口内回溯最近的句号或换行作为断点，避免把句子拦腰截断
      const c = Math.max(p.lastIndexOf('。', end), p.lastIndexOf('\n', end))
      // 断点必须落在窗口后半段（> 50%），否则宁可硬切也不产生过短片段
      if (c > i + maxChars * 0.5) end = c + 1
    }
    out.push(p.slice(i, end).trim())
    if (end >= p.length) break
    // 前进 = end - overlap（窗口重叠）；保底 +1 防止死循环（overlap 过大时）
    i = Math.max(end - overlap, i + 1)
  }
  return out.filter(Boolean)
}

/**
 * 标题分段：以 markdown 标题行为界，把全文切成 { title, body } 大块
 * - 标题行之后的内容归属该标题，直到下一个标题出现；
 * - 标题前的内容 title 为 ''（前言部分）；
 * - 全文无标题时退化为单块（title=''，body=原文），保证总有输出。
 */
function splitBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let title = '' // 当前生效的标题
  let buf = []   // 当前标题下累积的内容行
  const push = () => {
    const body = buf.join('\n').trim()
    if (body) blocks.push({ title, body })
    buf = []
  }
  for (const line of lines) {
    const m = line.match(HEADING)
    if (m) {
      push()           // 新标题出现：先定稿上一块
      title = m[2].trim()
    } else buf.push(line)
  }
  push() // 收尾：最后一个块
  return blocks.length ? blocks : [{ title: '', body: text }]
}
