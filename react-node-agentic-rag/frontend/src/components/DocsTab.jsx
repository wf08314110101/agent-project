import { useEffect, useRef, useState } from 'react'

const STATUS_META = {
  pending: { text: '排队中', cls: 'st-pending' },
  processing: { text: '摄取中', cls: 'st-processing' },
  ready: { text: '就绪', cls: 'st-ready' },
  failed: { text: '失败', cls: 'st-failed' },
}

export default function DocsTab() {
  const [docs, setDocs] = useState([])
  const [msg, setMsg] = useState('')
  const [uploading, setUploading] = useState(false)
  const timerRef = useRef(null)

  const load = async () => {
    try {
      const list = await (await fetch('/api/documents')).json()
      setDocs(list)
      // 有未完成的摄取 → 1.5s 后继续轮询，全部就绪/失败即停
      if (list.some((d) => d.status === 'pending' || d.status === 'processing')) {
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(load, 1500)
      }
    } catch (e) {
      setMsg(`加载失败: ${e.message}`)
    }
  }
  useEffect(() => {
    load()
    return () => clearTimeout(timerRef.current)
  }, [])

  async function upload(e) {
    const f = e.target.files[0]
    if (!f) return
    setUploading(true)
    setMsg(`已提交: ${f.name}，后台摄取中…`)
    try {
      const fd = new FormData()
      fd.append('file', f)
      const r = await fetch('/api/documents', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok) setMsg(`失败: ${j.error}`)
      else if (j.duplicated) setMsg(`内容重复，已跳过: ${j.doc.filename}`)
      else load() // 202 已入队，启动轮询
    } catch (err) {
      setMsg(`失败: ${err.message}`)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function del(id) {
    const r = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
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
                    {d.status === 'processing' && ' …'}
                  </span>
                </td>
                <td>{d.status === 'ready' ? d.chunks : '-'}</td>
                <td>{d.created_at}</td>
                <td><button className="del" onClick={() => del(d.id)}>删除</button></td>
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
