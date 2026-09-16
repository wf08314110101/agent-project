import { useEffect, useRef, useState } from 'react'
import { streamChat, fetchSessions, fetchMessages, removeSession } from '../api.js'

const PHASE_ICON = { action: '🔧', observation: '👁️', thought: '💭' }

// 正文引用渲染：把 [n] 拆成可点击徽标，点击高亮并滚动到对应来源卡片
// 无编号文本原样返回；n 超出来源数（模型编造/历史消息旧编号）时按纯文本处理
function renderContent(text, msgIndex, cites) {
  const parts = String(text).split(/(\[\d{1,2}\])/g)
  return parts.map((p, k) => {
    const m = p.match(/^\[(\d{1,2})\]$/)
    if (!m || !cites.has(+m[1])) return p
    return (
      <sup
        key={k}
        className="cite"
        onClick={() => {
          const el = document.getElementById(`src-${msgIndex}-${m[1]}`)
          if (!el) return
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          el.classList.add('hl')
          setTimeout(() => el.classList.remove('hl'), 1500)
        }}
      >
        {m[1]}
      </sup>
    )
  })
}

export default function ChatTab({ askDoc, onClearAsk }) {
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
        docId: askDoc?.id, // 指定文档问答：空 = 全库检索
        signal: ctrl.signal,
        onEvent: (ev, d) => {
          if (ev === 'sources') patchLast((x) => ({ ...x, sources: d.sources }))
          else if (ev === 'step') patchLast((x) => ({ ...x, steps: [...x.steps, d] }))
          else if (ev === 'reasoning') {
            // Thought 独立通道：思维链 token 不混入正文，折叠面板单独展示
            patchLast((x) => ({ ...x, reasoning: (x.reasoning ?? '') + d.text }))
          } else if (ev === 'delta') {
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
          {messages.map((m, i) => {
            const cites = new Set((m.sources ?? []).map((s) => s.cite ?? 0))
            return (
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
                {m.role === 'assistant' && m.reasoning && (
                  <details className="reasoning" open={m.status === 'streaming' && !m.content}>
                    <summary>💭 {m.status === 'streaming' && !m.content ? '思考中…' : '思考过程'}</summary>
                    <pre>{m.reasoning}</pre>
                  </details>
                )}
                {m.role === 'assistant' && m.sources?.length > 0 && (
                  <div className="sources">
                    <b>检索来源（{m.sources.length}）</b>
                    <ol>
                      {m.sources.map((s, j) => {
                        const n = s.cite ?? j + 1
                        return (
                          <li key={j} id={`src-${i}-${n}`}>
                            <span className="cite-no">[{n}]</span>
                            {s.url ? (
                              // 网络兜底来源：标题可点击跳原文，分数位显示来源域名
                              <a className="title src-web" href={s.url} target="_blank" rel="noreferrer">
                                🌐 {s.title || s.filename}
                              </a>
                            ) : (
                              <span className="title">{s.title || s.filename || '无标题'}</span>
                            )}
                            <span className="score">{s.url ? s.filename : s.score?.toFixed(3)}</span>
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                )}
                <div className="content">
                  {m.role === 'assistant'
                    ? renderContent(m.content || (m.status === 'streaming' ? '…' : ''), i, cites)
                    : m.content}
                </div>
                {m.usage && (
                  <div className="usage">
                    ⏱ {m.usage.elapsedSec}s ｜ 🧮 {m.usage.totalTokens} tok
                    （入 {m.usage.promptTokens} / 出 {m.usage.completionTokens}）｜ 🔄 {m.usage.rounds ?? 1} 轮
                  </div>
                )}
              </div>
            </div>
            )
          })}
        </div>

        <div className="input-bar">
          {askDoc && (
            <span className="ask-doc" title="仅在该文档范围内检索">
              📄 {askDoc.filename}
              <button onClick={onClearAsk}>×</button>
            </span>
          )}
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
