// ============================================================================
// API 层：token 管理 + 自动带 Authorization + 401 自续期（M14）+ SSE 流解析
// ----------------------------------------------------------------------------
// 鉴权约定（M14 无状态化）：登录后短效 access JWT + refresh token 存 localStorage；
// 所有请求经 request() 统一注入 Authorization；遇 401 先用 refreshToken 调
// /api/auth/refresh 续期（单飞，并发 401 共享一次刷新）并重放原请求一次，
// 续期失败才清 token 并触发 onUnauthorized 回调（App 切回登录页）。
// ============================================================================

const TOKEN_KEY = 'agr_token'
const REFRESH_KEY = 'agr_refresh'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))
const getRefreshToken = () => localStorage.getItem(REFRESH_KEY)
const setRefreshToken = (t) => (t ? localStorage.setItem(REFRESH_KEY, t) : localStorage.removeItem(REFRESH_KEY))

// 清空本地凭证并通知 App（切回登录页）
function clearAuth() {
  setToken(null)
  setRefreshToken(null)
  onUnauthorized()
}

// 401 回调：App.jsx 启动时注册（切回登录态），api 层不直接操作 UI
let onUnauthorized = () => { }
export const setOnUnauthorized = (fn) => (onUnauthorized = fn)

// refresh 单飞：并发多个 401 共享同一次刷新 promise；失败返回 null
let refreshing = null
async function tryRefresh() {
  const rt = getRefreshToken()
  if (!rt) return null
  refreshing ??= fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  })
    .then(async (res) => {
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return null
      setToken(j.token)
      setRefreshToken(j.refreshToken)
      return j.token
    })
    .catch(() => null)
    .finally(() => (refreshing = null))
  return refreshing
}

/** 统一请求通道：自动带 token，401 → 单飞续期并重放一次，仍失败清凭证通知 App */
export async function apiFetch(url, opts = {}, _retried = false) {
  const token = getToken()
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
  if (res.status === 401 && !_retried) {
    const next = await tryRefresh()
    if (next) return apiFetch(url, opts, true)
  }
  if (res.status === 401) {
    clearAuth()
    throw new Error('登录已过期，请重新登录')
  }
  return res
}

// SSE 帧解析（chat / 文档进度共用）：从 ReadableStream 按 \n\n 切帧回调 onEvent(event, data)
async function consumeSSE(res, onEvent) {
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

// SSE 流式问答：POST + ReadableStream 手动解析（EventSource 不支持 POST/自定义头）
export async function streamChat({ question, topK, sessionId, docId, stagingId, signal, onEvent }) {
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question, topK, sessionId,
      ...(docId ? { docId } : {}),
      ...(stagingId ? { stagingId } : {}), // M20 暂存附件
    }),
    signal,
  })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j.error || `HTTP ${res.status}`)
  }
  await consumeSSE(res, onEvent)
}

// M20 对话内暂存上传：拿 stagingId 随消息发送（批准后才真正入库）
export async function stageUpload(file) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await apiFetch('/api/staging', { method: 'POST', body: fd })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j // { stagingId, filename, size }
}

// M20 写审批决定：action = 'confirm' | 'reject'
export async function decideApproval(id, action) {
  const res = await apiFetch(`/api/approvals/${id}/${action}`, { method: 'POST' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j
}

// 文档摄取进度流：GET SSE，docs=全量快照 / doc=单文档状态变化（替代轮询）
export async function streamDocEvents({ signal, onEvent }) {
  const res = await apiFetch('/api/documents/events', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  await consumeSSE(res, onEvent)
}

// 登录：成功即存 access+refresh，返回用户对象 { username, role, dept }
export async function login(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  setToken(j.token)
  setRefreshToken(j.refreshToken)
  return { username: j.username, role: j.role ?? 'member', dept: j.dept ?? '' }
}

// 登出：吊销服务端 refresh（access 靠短效自然过期）+ 清本地凭证
export async function logout() {
  const rt = getRefreshToken()
  try {
    if (rt) await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    })
  } catch { /* 网络失败也照常清本地 */ }
  setToken(null)
  setRefreshToken(null)
}

// 会话管理
export const fetchSessions = () => apiFetch('/api/sessions').then((r) => r.json())
export const fetchMessages = (id) => apiFetch(`/api/sessions/${id}/messages`).then((r) => r.json())
export const removeSession = (id) => apiFetch(`/api/sessions/${id}`, { method: 'DELETE' })

// M10 RBAC：文档密级/标签/授权变更 + admin 用户列表（授权选择器用）
export const updateDoc = (id, patch) =>
  apiFetch(`/api/documents/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
export const fetchUsers = () => apiFetch('/api/admin/users').then((r) => (r.ok ? r.json() : []))

// 前端元信息（公开）：当前生效标签词表——随领域包注入变化，编辑器/筛选器动态取
export const fetchMeta = () => apiFetch('/api/meta').then((r) => (r.ok ? r.json() : { tagWhitelist: [] }))

// 文档预览（M17）：鉴权拉原文 → blob URL 交给浏览器原生渲染（pdf 阅读器 / 纯文本），
// 不在前端引入 markdown 渲染库；新标签页打开，60s 后回收 blob URL
export async function previewDoc(doc) {
  const res = await apiFetch(`/api/documents/${doc.id}/content`)
  if (!res.ok) throw new Error(`预览失败 HTTP ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
