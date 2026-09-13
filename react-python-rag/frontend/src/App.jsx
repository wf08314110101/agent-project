// RAG 前端主组件：录入（手输/上传）+ 问答（SSE 流式 + 召回来源展示）
import { useEffect, useState } from 'react'

// 通用 POST
async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

const Tab = ({ active, on, children }) => (
  <button className={active ? 'active' : ''} onClick={on}>{children}</button>
)

export default function App() {
  const [tab, setTab] = useState('ingest')
  const [stats, setStats] = useState(null)

  // 录入：手输
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  // 录入：文件
  const [uploading, setUploading] = useState(false)
  // 问答
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState('')
  const [sources, setSources] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = async () => {
    try {
      const s = await fetch('/api/stats').then((r) => r.json())
      setStats(s)
    } catch { setStats(null) }
  }
  useEffect(() => { refresh() }, [])

  const doIngest = async () => {
    if (!text.trim()) return
    setMsg('')
    try {
      const r = await post('/api/ingest', { text, title: title || '手动输入' })
      setMsg(`入库成功：${r.title} → ${r.chunks} 个切块`)
      setText(''); refresh()
    } catch (e) { setMsg('❌ ' + e.message) }
  }

  const doUpload = async (file) => {
    if (!file) return
    setUploading(true); setMsg('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/upload', { method: 'POST', body: fd }).then((x) => x.json())
      setMsg(`文件「${r.title}」→ ${r.chunks} 个切块`)
      refresh()
    } catch (e) { setMsg('❌ ' + e.message) } finally { setUploading(false) }
  }

  const doAsk = async () => {
    if (!q.trim() || busy) return
    setBusy(true); setAnswer(''); setSources([]); setMsg('')
    try {
      // SSE 流式读取：先收到 sources，再逐 token 收到 answer
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      if (!r.ok) throw new Error(await r.text())
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        // 按空行切 SSE 事件
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
          if (!raw.startsWith('data: ')) continue
          const obj = JSON.parse(raw.slice(6))
          if (obj.sources) setSources(obj.sources)
          if (obj.delta) setAnswer((a) => a + obj.delta)
        }
      }
    } catch (e) { setMsg('❌ ' + e.message) } finally { setBusy(false) }
  }

  return (
    <div style={{ maxWidth: 820, margin: '40px auto', padding: '0 16px' }}>
      <h1>RAG · 检索增强问答</h1>
      <div className="hint" style={{ marginBottom: 12 }}>
        已入库 {stats ? stats.documents : '–'} 个切块｜集合：{stats ? stats.collection : '–'}
      </div>

      <div className="tabs">
        <Tab active={tab === 'ingest'} on={() => setTab('ingest')}>录入文档</Tab>
        <Tab active={tab === 'ask'} on={() => setTab('ask')}>提问</Tab>
      </div>

      {tab === 'ingest' && (
        <>
          <div className="card">
            <h2>手动输入</h2>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴一段文本…" />
            <div style={{ marginTop: 8 }}>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题（可选）" />
              <button onClick={doIngest} style={{ marginTop: 8 }}>入库</button>
            </div>
          </div>

          <div className="card">
            <h2>上传文件</h2>
            <input
              type="file"
              accept=".txt,.md,.docx,.pdf,.png,.jpg,.jpeg,.bmp,.webp"
              disabled={uploading}
              onChange={(e) => { doUpload(e.target.files?.[0]); e.target.value = '' }}
            />
            <div className="hint">支持 txt / md / docx / pdf / 图片(OCR){uploading ? '（上传中…）' : ''}</div>
          </div>
        </>
      )}

      {tab === 'ask' && (
        <div className="card">
          <h2>向知识库提问</h2>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="例如：根据库里的资料，回答一个问题…"
            onKeyDown={(e) => e.key === 'Enter' && doAsk()} />
          <button onClick={doAsk} disabled={busy} style={{ marginTop: 8 }}>{busy ? '生成中…' : '提问'}</button>

          {sources.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="hint">召回片段（向量检索结果）：</div>
              {sources.map((s, i) => (
                <div className="src" key={i}>
                  <b>[{i + 1}] {s.title}</b>（距离 {s.distance}）<br />{s.chunk}
                </div>
              ))}
            </div>
          )}

          {answer && (
            <div className="answer" style={{ marginTop: 12 }}>
              <h2 style={{ fontSize: 14, color: '#22c55e' }}>回答</h2>
              <div>{answer}</div>
            </div>
          )}
        </div>
      )}

      {msg && <div className="hint" style={{ color: msg.startsWith('❌') ? '#ef4444' : '#22c55e' }}>{msg}</div>}
    </div>
  )
}