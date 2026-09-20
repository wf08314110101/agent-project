// ============================================================================
// 领域工具（api-docs）：fetch_api_doc —— 检索不足时按 URL 直接拉取官方文档页原文
// ----------------------------------------------------------------------------
// 契约与内核工具一致：出错不抛异常，错误文本作为 Observation 回喂模型自我修正；
// 返回的网页原文属不可信内容，必须 fenceUntrusted 定界包装（防间接注入）。
// ============================================================================

import { fenceUntrusted } from '../../agent/injection.js'

export const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'fetch_api_doc',
      description:
        '按 URL 拉取网页版 API 文档原文。当 search_knowledge 检索结果不足且资料中带有 sourceUrl 时，可用该 URL 补拉最新页面内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文档页 URL，必须以 https:// 开头' },
        },
        required: ['url'],
      },
    },
  },
]

const TIMEOUT_MS = 8000
const MAX_BYTES = 200 * 1024
const MAX_CHARS = 4000

// 轻量剥 HTML（领域自带，避免依赖内核 parser 的文件解析上下文）
const stripHtml = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')

export async function fetchApiDoc(args) {
  const url = String(args.url ?? '').trim()
  if (!/^https:\/\/\S+$/.test(url)) return '参数校验失败: url 必须是 https:// 开头的完整链接'
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'agentic-rag-fetcher/0.1' },
    })
    if (!r.ok) return `拉取失败: HTTP ${r.status}（检查 URL 是否有效）`
    const buf = await r.arrayBuffer()
    if (buf.byteLength > MAX_BYTES) return `页面过大（${Math.round(buf.byteLength / 1024)}KB），超出拉取上限`
    const ct = r.headers.get('content-type') ?? ''
    let text = await new Response(buf).text()
    if (ct.includes('html')) text = stripHtml(text)
    text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) return '页面解析结果为空'
    // 网页原文不可信：定界包装后回喂（系统提示规则 5 声明边界内皆为数据）
    return `已拉取 ${url}（${text.length} 字符，超长已截断）:\n\n${fenceUntrusted(text.slice(0, MAX_CHARS))}`
  } catch (e) {
    return `拉取失败: ${e.name === 'TimeoutError' ? `超时（${TIMEOUT_MS / 1000}s）` : e.message}`
  }
}

export const handlers = { fetch_api_doc: fetchApiDoc }
