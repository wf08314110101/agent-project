// SSE 解析：按空行切帧，event/data 两行一帧
export async function streamChat({ question, topK, sessionId, signal, onEvent }) {
  const res = await fetch('/api/chat', {
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

// 会话管理
export const fetchSessions = () => fetch('/api/sessions').then((r) => r.json())
export const fetchMessages = (id) => fetch(`/api/sessions/${id}/messages`).then((r) => r.json())
export const removeSession = (id) => fetch(`/api/sessions/${id}`, { method: 'DELETE' })
