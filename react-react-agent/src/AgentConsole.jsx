import { useReducer, useRef, useState, useEffect } from 'react'
import { agent } from './agent'

/**
 * 多轮对话版 ReAct Agent 控制台（真·流式）
 * - sessionRef：发给 LLM 的完整上下文，跨多次运行累积（含历史用户问题 + 各轮 assistant/tool/Observation）
 * - history：UI 展示用，user 一条、assistant 一条（assistant 块内含 ReAct 全程彩字日志）
 */

// 每个 token/日志都会触发 append，用 reducer 保证不可变更新、避免闭包过期
function reducer(state, action) {
  switch (action.type) {
    case 'addUser': {
      const chunks = Array.from(String(action.content)).map((ch) => ({ ch, type: 'user' }))
      return { items: [...state.items, { id: 'u' + state.items.length, role: 'user', chunks }] }
    }
    case 'addAssistant':
      return { items: [...state.items, { id: 'a' + state.items.length, role: 'assistant', chunks: [] }] }
    case 'append': {
      const items = [...state.items]
      const last = items[items.length - 1]
      items[items.length - 1] = { ...last, chunks: [...last.chunks, { ch: action.ch, type: action.extra }] }
      return { items }
    }
    default:
      return state
  }
}

export default function AgentConsole() {
  const [prompt, setPrompt] = useState('帮我算 (2+3)*4 的结果，再报告北京今天天气？')
  const [state, dispatch] = useReducer(reducer, { items: [] })
  const [running, setRunning] = useState(false)
  const abortRef = useRef(null)
  const sessionRef = useRef([]) // ⭐ 会话级共享上下文：跨多次运行累积，形成多轮记忆
  const scrollRef = useRef(null) // 滚动容器：内容更新后自动滚到底
  const stickRef = useRef(true) // 是否跟随底部：用户主动上翻则临时关闭，避免被打断

  // 对话总字符数变化（新 token / 新条目）→ 自动滚动到底
  const totalChars = state.items.reduce((s, it) => s + it.chunks.length, 0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const scroll = () => {
      el.scrollTop = el.scrollHeight
    }
    if (running) {
      // 流式中：实时跟随底部（除非用户主动上翻过）
      if (stickRef.current) requestAnimationFrame(scroll)
    } else {
      // 生成刚结束：重置跟随 + 双 rAF 等布局完成后滚到底，保证「用时/token」汇总行完整可见
      stickRef.current = true
      const a = requestAnimationFrame(scroll)
      const b = requestAnimationFrame(scroll)
      return () => {
        cancelAnimationFrame(a)
        cancelAnimationFrame(b)
      }
    }
  }, [totalChars, running])

  // 逐 token / 逐字符回调 → 追到当前 assistant 块
  // 注意：reducer 的 action.type 固定为 'append'，着色用 extra 字段，避免与 type 冲突
  const onToken = (ch, type) => dispatch({ type: 'append', ch, extra: type })
  const onLog = (text, type = 'info') => {
    if (text === '') return
    for (const ch of Array.from(String(text))) dispatch({ type: 'append', ch, extra: type })
  }

  const run = async () => {
    if (running || !prompt.trim()) return
    const q = prompt.trim()
    setRunning(true)
    setPrompt('')

    // 1) 把当前用户问题写进共享上下文（历史由此累积，多轮记忆）
    sessionRef.current.push({ role: 'user', content: q })
    // 2) UI：新增 user 条目 + 空的 assistant 条目（流式内容打进这里）
    dispatch({ type: 'addUser', content: q })
    dispatch({ type: 'addAssistant' })

    const ac = new AbortController()
    abortRef.current = ac
    try {
      await agent(sessionRef.current, onLog, {
        onToken,
        maxIterations: 6, // 防无限死循环
        signal: ac.signal,
      })
    } catch (e) {
      if (e.name === 'AbortError') onLog('⏹️ 已手动停止', 'warn')
      else onLog('❌ ' + e.message, 'error')
    } finally {
      setRunning(false)
    }
  }

  const stop = () => abortRef.current?.abort()

  return (
    <div style={{ maxWidth: 800, margin: '40px auto', fontFamily: 'system-ui' }}>
      <h1>React ReAct Agent（多轮对话 · 流式）</h1>

      {/* ---- 会话区：多轮对话都在这里 ---- */}
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current
          if (!el || !running) return
          // 距底部 <40px 视为"跟随中"；否则视为用户主动上翻，暂停实时跟随
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        style={{
          background: '#f4f4f5',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 12,
          minHeight: 340,
          maxHeight: 520,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: 13,
        }}
      >
        {state.items.length === 0 ? (
          <div style={{ color: '#9ca3af' }}>输入问题开始对话，可连续追问（共享历史上下文）……</div>
        ) : (
          state.items.map((item, i) =>
            item.role === 'user' ? (
              // 用户消息
              <div key={item.id} style={{ margin: '10px 0' }}>
                <span
                  style={{
                    background: '#3b82f6',
                    color: '#fff',
                    borderRadius: 8,
                    borderBottomLeftRadius: 2,
                    padding: '4px 10px',
                    display: 'inline-block',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'system-ui',
                    fontSize: 14,
                  }}
                >
                  {item.chunks.map((c) => c.ch).join('')}
                </span>
              </div>
            ) : (
              // Agent 回复（含 ReAct 全流程：Thought/Action/Observation/Final）
              <div
                key={item.id}
                style={{ background: '#1e1e1e', color: '#fff', borderRadius: 8, padding: 10, margin: '10px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {item.chunks.map((c, ci) => (
                  <span key={ci} style={{ color: colorOf(c.type) }}>
                    {c.ch}
                  </span>
                ))}
                {/* 正在生成时的闪烁光标 */}
                {running && i === state.items.length - 1 && (
                  <span style={{ color: '#fff', animation: 'blink 0.8s step-start infinite' }}>▍</span>
                )}
              </div>
            )
          )
        )}
      </div>

      {/* ---- 输入区 ---- */}
      <div style={{ margin: '12px 0', display: 'flex', gap: 8 }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && run()}
          rows={2}
          style={{ flex: 1, padding: 8, fontSize: 14, resize: 'none' }}
          placeholder='输入问题，回车发送'
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={run} disabled={running}>
            {running ? '生成中…' : '发送'}
          </button>
          {running && (
            <button onClick={stop}>⏹ 停止</button>
          )}
        </div>
      </div>

      <style>{'@keyframes blink { 50% { opacity: 0 } }'}</style>
    </div>
  )
}

/** 按阶段着色 */
function colorOf(type) {
  switch (type) {
    case 'tool':
      return '#22d3ee' // 青（工具名）
    case 'action':
      return '#facc15' // 黄（动作/参数）
    case 'obs':
    case 'ok':
      return '#4ade80' // 绿（观测/成功）
    case 'warn':
      return '#fbbf24' // 橙黄
    case 'error':
      return '#ff6666' // 红
    case 'step':
      return '#888' // 灰（轮次）
    case 'meta':
      return '#c084fc' // 紫（用时/token）
    case 'content':
    default:
      return '#dcdcdc'
  }
}