import { useEffect, useRef, useState } from 'react'
import { apiFetch, streamDocEvents } from '../api.js'

const STATUS_META = {
  pending: { text: '排队中', cls: 'st-pending' },
  processing: { text: '摄取中', cls: 'st-processing' },
  ready: { text: '就绪', cls: 'st-ready' },
  failed: { text: '失败', cls: 'st-failed' },
}

export default function DocsTab({ onAsk }) {
  const [docs, setDocs] = useState([])
  const [msg, setMsg] = useState('')
  const [uploading, setUploading] = useState(false)
  const timerRef = useRef(null)

  const load = async () => {
    try {
      setDocs(await (await apiFetch('/api/documents')).json())
    } catch (e) {
      setMsg(`加载失败: ${e.message}`)
    }
  }

  // SSE 兜底轮询：进度流断开/不可用时，退回 1.5s 轮询直到无未完成文档
  // （用刚拉到的 list 判断续跑，避免闭包里 docs 状态过期）
  const startPolling = () => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      try {
        const list = await (await apiFetch('/api/documents')).json()
        setDocs(list)
        if (list.some((d) => d.status === 'pending' || d.status === 'processing')) startPolling()
      } catch {
        startPolling()
      }
    }, 1500)
  }

  useEffect(() => {
    let stop = false
    const ctrl = new AbortController()
    load() // 首屏直拉一次（SSE 快照随后到达，幂等）
    // 摄取进度订阅：docs=全量快照 / doc=单文档状态变化（含 progress 百分比）
    streamDocEvents({
      signal: ctrl.signal,
      onEvent: (ev, d) => {
        if (stop) return
        if (ev === 'docs') setDocs(d.docs)
        else if (ev === 'doc') {
          setDocs((list) =>
            list.some((x) => x.id === d.id)
              ? list.map((x) => (x.id === d.id ? { ...x, ...d, error: d.error ?? x.error } : x))
              : load() // 未知文档（本端列表滞后）→ 直接刷新
          )
        }
      },
    }).catch(() => { if (!stop) startPolling() }) // SSE 失败 → 轮询兜底
    return () => { stop = true; ctrl.abort(); clearTimeout(timerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function upload(e) {
    const f = e.target.files[0]
    if (!f) return
    setUploading(true)
    setMsg(`已提交: ${f.name}，后台摄取中…`)
    try {
      const fd = new FormData()
      fd.append('file', f)
      const r = await apiFetch('/api/documents', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok) setMsg(`失败: ${j.error}`)
      else if (j.duplicated) setMsg(`内容重复，已跳过: ${j.doc.filename}`)
      else load() // 202 已入队，进度由 SSE 推送
    } catch (err) {
      setMsg(`失败: ${err.message}`)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function del(id) {
    const r = await apiFetch(`/api/documents/${id}`, { method: 'DELETE' })
    if (!r.ok) setMsg(`删除失败: ${(await r.json()).error}`)
    load()
  }

  return (
    <div className="docs">
      <div className="upload-bar">
        <label className="upload-btn">
          选择文件上传
          <input
            type="file"
            accept=".md,.markdown,.txt,.pdf,.docx,.csv,.json,.html,.htm,.log"
            onChange={upload}
            disabled={uploading}
            hidden
          />
        </label>
        <span className="hint">支持 md/txt/pdf/docx/csv/json/html，同内容文件自动去重，摄取后台进行</span>
      </div>
      {msg && <div className="doc-msg">{msg}</div>}
      <table>
        <thead>
          <tr><th>文件名</th><th>大小</th><th>状态</th><th>分块</th><th>入库时间</th><th></th></tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const st = STATUS_META[d.status] ?? { text: d.status, cls: '' }
            return (
              <tr key={d.id}>
                <td>{d.filename}</td>
                <td>{(d.size / 1024).toFixed(1)} KB</td>
                <td>
                  <span className={`doc-status ${st.cls}`} title={d.error || ''}>
                    {st.text}
                    {d.status === 'processing' && d.progress != null ? ` ${d.progress}%` : ' …'}
                  </span>
                </td>
                <td>{d.status === 'ready' ? d.chunks : '-'}</td>
                <td>{d.created_at}</td>
                <td className="row-actions">
                  <button
                    className="ask"
                    disabled={d.status !== 'ready'}
                    title={d.status === 'ready' ? `仅检索《${d.filename}》进行问答` : '仅就绪文档可提问'}
                    onClick={() => onAsk?.(d)}
                  >
                    提问
                  </button>
                  <button className="del" onClick={() => del(d.id)}>删除</button>
                </td>
              </tr>
            )
          })}
          {docs.length === 0 && (
            <tr><td colSpan="6" className="empty">暂无文档</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
