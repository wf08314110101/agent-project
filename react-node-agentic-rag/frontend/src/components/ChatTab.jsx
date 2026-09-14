import { useEffect, useRef, useState } from 'react'
import { streamChat, fetchSessions, fetchMessages, removeSession } from '../api.js'

const PHASE_ICON = { action: '🔧', observation: '👁️', thought: '💭' }

export default function ChatTab() {
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [topK, setTopK] = useState(5)
  const [busy, setBusy] = useState(false)
  const abortRef = useRef(null)
  const boxRef = useRef(null)

  useEffect(() => {
    fetchSessions().then(setSessions).catch(() => {})
  }, [])

  const refreshSessions = () => fetchSessions().then(setSessions).catch(() => {})
  const scroll = () =>
    requestAnimationFrame(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight))

  // 修补最后一条 assistant 消息
  const patchLast = (fn) =>
    setMessages((m) => {
      const c = [...m]
      c[c.length - 1] = fn({ ...c[c.length - 1] })
      return c
    })

  async function openSession(id) {
    if (busy || id === sessionId) return
    setSessionId(id)
    const rows = await fetchMessages(id)
    setMessages(
      rows.map((m) => ({
        role: m.role,
        content: m.content,
        sources: m.meta?.sources ?? [],
        steps: m.meta?.steps ?? [],
        usage: m.meta?.usage ?? null,
        status: 'done',
      }))
    )
    scroll()
  }

  async function delSession(id) {
    await removeSession(id)
    if (id === sessionId) {
      setSessionId(null)
      setMessages([])
    }
    refreshSessions()
  }

  const newChat = () => {
    if (busy) return
    setSessionId(null)
    setMessages([])
  }

  async function send() {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setBusy(true)
    setMessages((m) => [
      ...m,
      { role: 'user', content: q },
      { role: 'assistant', content: '', sources: [], steps: [], usage: null, status: 'streaming' },
    ])
    scroll()

    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await streamChat({
        question: q,
        topK,
        sessionId,
        signal: ctrl.signal,
        onEvent: (ev, d) => {
          if (ev === 'sources') patchLast((x) => ({ ...x, sources: d.sources }))
          else if (ev === 'step') patchLast((x) => ({ ...x, steps: [...x.steps, d] }))
          else if (ev === 'delta') {
            patchLast((x) => ({ ...x, content: x.content + d.text }))
            scroll()
          } else if (ev === 'usage') patchLast((x) => ({ ...x, usage: d }))
          else if (ev === 'done') {
            patchLast((x) => ({ ...x, status: d.stopReason }))
            setSessionId(d.sessionId ?? null)
            refreshSessions()
          } else if (ev === 'error') {
            patchLast((x) => ({ ...x, status: 'error', content: `${x.content}\n[错误] ${d.message}` }))
          }
        },
      })
    } catch (e) {
      if (e.name !== 'AbortError')
        patchLast((x) => ({ ...x, status: 'error', content: `${x.content}\n[错误] ${e.message}` }))
    } finally {
      setBusy(false)
      abortRef.current = null
      patchLast((x) => (x.status === 'streaming' ? { ...x, status: 'done' } : x))
    }
  }

  const stop = () => abortRef.current?.abort()
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat">
      <aside className="sessions">
        <button className="new-chat" onClick={newChat} disabled={busy}>＋ 新对话</button>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session ${s.id === sessionId ? 'on' : ''}`}
              onClick={() => openSession(s.id)}
            >
              <span className="title">{s.title}</span>
              <button className="del" onClick={(e) => { e.stopPropagation(); delSession(s.id) }}>×</button>
            </div>
          ))}
          {sessions.length === 0 && <div className="session-empty">暂无会话</div>}
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-box" ref={boxRef}>
          {messages.length === 0 && (
            <div className="empty">上传文档后提问，Agent 会自主检索、评估并改写查询</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">
                {m.role === 'assistant' && m.steps?.length > 0 && (
                  <div className="steps">
                    {m.steps.map((s, j) => (
                      <details key={j}>
                        <summary>
                          {PHASE_ICON[s.phase] ?? '•'} {s.label || s.phase}
                        </summary>
                        <pre>{s.content}</pre>
                      </details>
                    ))}
                  </div>
                )}
                {m.role === 'assistant' && m.sources?.length > 0 && (
                  <div className="sources">
                    <b>检索来源（{m.sources.length}）</b>
                    <ol>
                      {m.sources.map((s, j) => (
                        <li key={j}>
                          <span className="title">{s.title || s.filename || '无标题'}</span>
                          <span className="score">{s.score?.toFixed(3)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <div className="content">
                  {m.content || (m.status === 'streaming' ? '…' : '')}
                </div>
                {m.usage && (
                  <div className="usage">
                    ⏱ {m.usage.elapsedSec}s ｜ 🧮 {m.usage.totalTokens} tok
                    （入 {m.usage.promptTokens} / 出 {m.usage.completionTokens}）｜ 🔄 {m.usage.rounds ?? 1} 轮
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="input-bar">
          <label className="topk">
            top-k
            <input
              type="number"
              min="1"
              max="20"
              value={topK}
              onChange={(e) => setTopK(Math.max(1, Math.min(20, +e.target.value || 5)))}
            />
          </label>
          <textarea
            value={input}
            rows={2}
            placeholder="输入问题，Enter 发送 / Shift+Enter 换行"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={busy}
          />
          {busy ? (
            <button className="stop" onClick={stop}>停止</button>
          ) : (
            <button className="send" onClick={send} disabled={!input.trim()}>发送</button>
          )}
        </div>
      </div>
    </div>
  )
}
