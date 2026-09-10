import { useState, useRef } from 'react'
import { agent } from './agent'

/**
 * React 版 ReAct Agent 控制台（真·流式）
 * LLM 请求走 stream:true，token 逐字到达即渲染；
 * 工具输出在 agent 层 typeOut 逐字推到这。无需前端模拟打字机。
 */
export default function AgentConsole() {
  const [prompt, setPrompt] = useState('帮我算 (2+3)*4 的结果，再报告北京今天天气？')
  const [flat, setFlat] = useState([]) // 每元素 { ch, type }
  const [running, setRunning] = useState(false)
  const abortRef = useRef(null)

  // token 到达 → 追加单个字符（直接驱动渲染，真流式）
  const onToken = (ch, type) =>
    setFlat((prev) => [...prev, { ch, type }])

  // 一次性日志：换行/分隔/错误提示整段推入（内部仍按单字存，便于统一渲染）
  const onLog = (text, type = 'info') => {
    if (text === '' ) return
    setFlat((prev) => [...prev, ...Array.from(String(text)).map((ch) => ({ ch, type }))])
  }

  const run = async () => {
    if (running || !prompt.trim()) return
    setRunning(true)
    setFlat([])
    const ac = new AbortController()
    abortRef.current = ac

    try {
      await agent(prompt.trim(), onLog, {
        onToken, // 传入逐字符回调
        maxIterations: 6,
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
      <h1>React 版 ReAct Agent（真·流式）</h1>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        style={{ width: '100%', padding: 8, fontSize: 14 }}
      />
      <div style={{ margin: '12px 0' }}>
        <button onClick={run} disabled={running} style={{ marginRight: 8 }}>
          {running ? '运行中…' : '运行'}
        </button>
        {running && (
          <button onClick={stop} style={{ marginRight: 8 }}>
            ⏹ 停止
          </button>
        )}
      </div>
      <div
        style={{
          background: '#1e1e1e',
          color: '#fff',
          padding: 12,
          minHeight: 300,
          borderRadius: 8,
          fontFamily: 'monospace',
          fontSize: 13,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {flat.length === 0 ? (
          '（这里会实时输出 Thought / Action / Observation / Final Answer）'
        ) : (
          <>
            {flat.map((c, i) => (
              <span key={i} style={{ color: colorOf(c.type) }}>
                {c.ch}
              </span>
            ))}
            {running && (
              <span style={{ color: '#fff', animation: 'blink 0.8s step-start infinite' }}>▍</span>
            )}
          </>
        )}
      </div>
      <style>{'@keyframes blink { 50% { opacity: 0 } }'}</style>
    </div>
  )
}

/** 按阶段着色：内容(白) / 工具(青) / 动作(黄) / 观测(绿) / 成功(绿) / 错误/警告(红) / 轮次(灰) */
function colorOf(type) {
  switch (type) {
    case 'tool':
      return '#22d3ee' // 青
    case 'action':
      return '#facc15' // 黄
    case 'obs':
    case 'ok':
      return '#4ade80' // 绿
    case 'warn':
      return '#fbbf24' // 橙黄
    case 'error':
      return '#ff6666' // 红
    case 'step':
      return '#888' // 灰
    case 'meta':
      return '#c084fc' // 紫：用时/token 汇总
    case 'content':
    default:
      return '#dcdcdc'
  }
}