// ============================================================================
// API 层：token 管理 + 自动带 Authorization + 401 全局处理 + SSE 流解析
// ----------------------------------------------------------------------------
// 鉴权约定（M5）：登录后 JWT 存 localStorage；所有请求经 request() 统一注入
// Authorization 头；遇 401 自动清 token 并触发 onUnauthorized 回调（App 切回登录页）。
// ============================================================================

const TOKEN_KEY = 'agr_token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))

// 401 回调：App.jsx 启动时注册（切回登录态），api 层不直接操作 UI
let onUnauthorized = () => {}
export const setOnUnauthorized = (fn) => (onUnauthorized = fn)

/** 统一请求通道：自动带 token，401 → 清 token + 通知 App */
export async function apiFetch(url, opts = {}) {
  const token = getToken()
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
  if (res.status === 401) {
    setToken(null)
    onUnauthorized()
    throw new Error('登录已过期，请重新登录')
  }
  return res
}

// SSE 流式问答：POST + ReadableStream 手动解析（EventSource 不支持 POST/自定义头）
export async function streamChat({ question, topK, sessionId, signal, onEvent }) {
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, topK, sessionId }),
    signal,
  })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j.error || `HTTP ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const ev = {}
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) ev.event = line.slice(7)
        else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6))
      }
      if (ev.event) onEvent(ev.event, ev.data)
    }
  }
}

// 登录：成功即存 token，返回用户名
export async function login(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  setToken(j.token)
  return j.username
}

// 会话管理
export const fetchSessions = () => apiFetch('/api/sessions').then((r) => r.json())
export const fetchMessages = (id) => apiFetch(`/api/sessions/${id}/messages`).then((r) => r.json())
export const removeSession = (id) => apiFetch(`/api/sessions/${id}`, { method: 'DELETE' })
