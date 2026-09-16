// ============================================================================
// 网络搜索兜底（CRAG「库内不足 → 联网补救」一环）
// ----------------------------------------------------------------------------
// provider 抽象（WEB_SEARCH_PROVIDER）：
//   bing   : 默认，免 key 抓取 cn.bing.com 结果页（<li class="b_algo"> 块正则解析）
//   tavily : 面向 RAG 的搜索 API，需 TAVILY_API_KEY
//   off    : 关闭兜底（search_kb 的 webEligible 恒 false，行为与旧版一致）
// 统一返回 [{ title, url, snippet }]；任何失败都降级为空数组，不阻断问答主链路。
// ============================================================================

import { config } from '../config.js'
import { otelSpan } from '../obs/otel.js'

// 兜底是否可用（grade 路由据此决定是否进入 web_search 节点）
export const webSearchAvailable = () => config.webSearch.provider !== 'off'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 去标签 + HTML 实体反解码（Bing 标题/摘要里常见 &ensp; &#183; 等）
const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&ensp;|&emsp;/g, ' ')
    .replace(/&#0?183;/g, '·')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

// Bing 结果页抓取：www.bing.com 会 302 到 cn.bing.com（redirect: follow 即可）
async function bingSearch(q, { signal, count }) {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${count}&setmkt=zh-CN&setlang=zh-hans`,
    { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, redirect: 'follow', signal }
  )
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`)
  const html = await res.text()
  const out = []
  const re = /<li class="b_algo".*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g
  let m
  while ((m = re.exec(html)) && out.length < count) {
    if (!/^https?:\/\//.test(m[1])) continue // 跳过站内/广告跳转链接
    const p = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = p ? decode(p[1]) : ''
    if (!snippet) continue
    out.push({ url: decode(m[1]), title: decode(m[2]), snippet })
  }
  return out
}

// Tavily（RAG 搜索 API）：结果自带摘要正文，质量比页面抓取稳，但有 key 成本
async function tavilySearch(q, { signal, count }) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: config.webSearch.tavilyKey,
      query: q,
      max_results: count,
      search_depth: 'basic',
    }),
    signal,
  })
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)
  const j = await res.json()
  return (j.results ?? [])
    .filter((r) => r.url && r.content)
    .map((r) => ({ url: r.url, title: r.title ?? '', snippet: r.content }))
}

/**
 * 网络搜索：按 provider 分发；失败/超时返回空数组（= 无兜底资料，主链路继续）
 * @param {string} q - 搜索查询
 * @param {{ signal?: AbortSignal, count?: number }} opts
 */
export async function webSearch(q, { signal, count = config.webSearch.maxResults } = {}) {
  const span = otelSpan('web_search', 'TOOL', {
    'input.value': q,
    'web.provider': config.webSearch.provider,
  })
  try {
    // 超时兜底：调用方 signal 与固定超时合并，防搜索挂死拖垮整轮对话
    const timeout = AbortSignal.timeout(config.webSearch.timeoutMs)
    const s = signal ? AbortSignal.any([signal, timeout]) : timeout
    const fn = config.webSearch.provider === 'tavily' ? tavilySearch : bingSearch
    const results = await fn(q, { signal: s, count })
    span.end(`命中 ${results.length}`)
    return results
  } catch (e) {
    span.end(`搜索失败: ${e.message}`, { level: 'ERROR', statusMessage: e.message })
    return []
  }
}
