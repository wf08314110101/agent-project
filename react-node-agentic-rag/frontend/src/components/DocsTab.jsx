import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, streamDocEvents, updateDoc, fetchUsers, fetchMeta, previewDoc } from '../api.js'

const STATUS_META = {
  pending: { text: '排队中', cls: 'st-pending' },
  processing: { text: '摄取中', cls: 'st-processing' },
  ready: { text: '就绪', cls: 'st-ready' },
  failed: { text: '失败', cls: 'st-failed' },
}
const CLS_META = {
  public: { text: '公开', cls: 'cls-public' },
  dept: { text: '部门', cls: 'cls-dept' },
  private: { text: '私有', cls: 'cls-private' },
}
export const CLASSIFICATIONS = ['public', 'dept', 'private']
// M17 集合友好名：内部集合名不进 UI，未知集合回退原名
const COLLECTION_META = { agentic_docs: '核心库', rag_api_docs: 'API 文档' }
const parseTags = (s) => { try { return JSON.parse(s) ?? [] } catch { return [] } }
// ISO 时间戳 → 本地短格式（无秒/时区后缀）
const fmtTime = (iso) => {
  const d = new Date(iso)
  return isNaN(d) ? iso : d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function DocsTab({ user, onAsk }) {
  const [docs, setDocs] = useState([])
  const [msg, setMsg] = useState('')
  const [uploading, setUploading] = useState(false)
  // 上传表单：密级（默认 private 最小暴露面）+ 标签（受控枚举多选）
  const [upCls, setUpCls] = useState('private')
  const [upTags, setUpTags] = useState([])
  // 列表筛选：密级 + 标签（client-side，量级小不做服务端分页）
  const [fCls, setFCls] = useState('')
  const [fTag, setFTag] = useState('')
  // 行内编辑器：编辑目标文档 id + 表单状态；users 仅 admin 可拉取（403 时为空数组）
  const [editing, setEditing] = useState(null) // { id, classification, tags: [], grants: [] }
  const [users, setUsers] = useState([])
  // M17 标签词表动态化：随领域包注入变化（/api/meta），不再前端硬编码
  const [tagList, setTagList] = useState([])
  const timerRef = useRef(null)

  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    fetchMeta().then((m) => setTagList(m.tagWhitelist ?? [])).catch(() => {})
  }, [])

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
      fd.append('classification', upCls)
      fd.append('tags', upTags.join(','))
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

  // 打开行内编辑器：预填当前密级/标签/授权；admin 顺带拉用户列表供授权勾选
  function openEdit(d) {
    setEditing({ id: d.id, filename: d.filename, classification: d.classification ?? 'private', tags: parseTags(d.tags), grants: d.grants ?? [] })
    if (isAdmin) fetchUsers().then(setUsers).catch(() => setUsers([]))
  }

  // 编辑弹窗：Esc 关闭（遮罩点击关闭在 overlay onClick 上）
  useEffect(() => {
    if (!editing) return
    const onKey = (e) => e.key === 'Escape' && setEditing(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  async function saveEdit() {
    try {
      const r = await updateDoc(editing.id, {
        classification: editing.classification,
        tags: editing.tags,
        grants: editing.grants,
      })
      if (!r.ok) setMsg(`保存失败: ${(await r.json()).error}`)
      setEditing(null)
      load()
    } catch (e) {
      setMsg(`保存失败: ${e.message}`)
    }
  }

  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  const visible = useMemo(
    () => docs.filter((d) => (!fCls || d.classification === fCls) && (!fTag || parseTags(d.tags).includes(fTag))),
    [docs, fCls, fTag]
  )

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
        <select className="cls-select" value={upCls} onChange={(e) => setUpCls(e.target.value)} title="保密等级">
          {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{CLS_META[c].text}</option>)}
        </select>
        <div className="tag-picker">
          {tagList.map((t) => (
            <button
              key={t}
              type="button"
              className={`tag-chip ${upTags.includes(t) ? 'on' : ''}`}
              onClick={() => setUpTags((a) => toggle(a, t))}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="hint">同内容文件自动去重，默认私有（仅本人可见），摄取后台进行</span>
      </div>
      <div className="filter-bar">
        <button className={`filter-chip ${!fCls && !fTag ? 'on' : ''}`} onClick={() => { setFCls(''); setFTag('') }}>全部</button>
        {CLASSIFICATIONS.map((c) => (
          <button key={c} className={`filter-chip ${fCls === c ? 'on' : ''}`} onClick={() => setFCls(fCls === c ? '' : c)}>
            {CLS_META[c].text}
          </button>
        ))}
        {tagList.map((t) => (
          <button key={t} className={`filter-chip ${fTag === t ? 'on' : ''}`} onClick={() => setFTag(fTag === t ? '' : t)}>
            #{t}
          </button>
        ))}
      </div>
      {msg && <div className="doc-msg">{msg}</div>}
      <table>
        <thead>
          <tr><th>文件名</th><th>集合</th><th>密级/标签</th><th>大小</th><th>状态</th><th>分块</th><th>入库时间</th><th></th></tr>
        </thead>
        <tbody>
          {visible.map((d) => {
            const st = STATUS_META[d.status] ?? { text: d.status, cls: '' }
            const cm = CLS_META[d.classification] ?? { text: d.classification, cls: '' }
            const mine = !d.owner_name || d.owner_name === (user?.username ?? user) // 归属判定（SSE doc 事件无 owner_name，沿用快照值）
            const canEdit = isAdmin || mine
            return (
              <tr key={d.id}>
                <td>
                  <button
                    className="link-filename"
                    disabled={d.status !== 'ready'}
                    title={d.status === 'ready' ? '点击预览原文（新标签页）' : '摄取就绪后可预览'}
                    onClick={() => previewDoc(d)}
                  >
                    {d.filename}
                  </button>
                  {d.status === 'ready' && d.deprecated && <span className="owner-tag" title="已废弃资料，仅作历史参考">已废弃</span>}
                  {!mine && <span className="owner-tag" title={`归属: ${d.owner_name ?? '他人'}${d.owner_dept ? ' · ' + d.owner_dept : ''}`}>{d.owner_name ?? '他人'}</span>}
                </td>
                <td>
                  <span className="cls-badge col-collection" title={`集合: ${d.collection ?? '-'}`}>
                    {COLLECTION_META[d.collection] ?? d.collection ?? '-'}
                  </span>
                </td>
                <td>
                  <span className={`cls-badge ${cm.cls}`}>{cm.text}</span>
                  {parseTags(d.tags).map((t) => <span key={t} className="doc-tag">{t}</span>)}
                </td>
                <td>{(d.size / 1024).toFixed(1)} KB</td>
                <td>
                  <span className={`doc-status ${st.cls}`} title={d.error || ''}>
                    {st.text}
                    {d.status === 'processing' && (d.progress != null ? ` ${d.progress}%` : ' …')}
                  </span>
                </td>
                <td>{d.status === 'ready' ? d.chunks : '-'}</td>
                <td>{fmtTime(d.created_at)}</td>
                <td className="row-actions">
                  <button
                    className="ask"
                    disabled={d.status !== 'ready'}
                    title={d.status === 'ready' ? `仅检索《${d.filename}》进行问答` : '仅就绪文档可提问'}
                    onClick={() => onAsk?.(d)}
                  >
                    提问
                  </button>
                  {canEdit && <button className="edit" onClick={() => (editing?.id === d.id ? setEditing(null) : openEdit(d))}>设置</button>}
                  {canEdit && <button className="del" onClick={() => del(d.id)}>删除</button>}
                </td>
              </tr>
            )
          })}
          {visible.length === 0 && (
            <tr><td colSpan="8" className="empty">暂无文档</td></tr>
          )}
        </tbody>
      </table>
      {editing && (
        <div className="doc-editor-overlay" onClick={() => setEditing(null)}>
          <div className="doc-editor" onClick={(e) => e.stopPropagation()}>
            <div className="editor-head">
              <span className="editor-title">文档设置 · {editing.filename}</span>
              <button className="editor-close" onClick={() => setEditing(null)} title="关闭 (Esc)">×</button>
            </div>
            <div className="editor-row">
              <label>密级</label>
              <select
                value={editing.classification}
                onChange={(e) => setEditing({ ...editing, classification: e.target.value })}
              >
                {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{CLS_META[c].text}</option>)}
              </select>
              <span className="hint">
                {editing.classification === 'public' && '全体登录用户可读'}
                {editing.classification === 'dept' && '与归属人同部门可读'}
                {editing.classification === 'private' && '仅本人与被授权用户可读'}
              </span>
            </div>
            <div className="editor-row">
              <label>标签</label>
              <div className="tag-picker">
                {tagList.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`tag-chip ${editing.tags.includes(t) ? 'on' : ''}`}
                    onClick={() => setEditing({ ...editing, tags: toggle(editing.tags, t) })}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          {isAdmin && users.length > 0 && (
            <div className="editor-row">
              <label>授权</label>
              <div className="tag-picker">
                {users.filter((u) => u.username !== user?.username).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className={`tag-chip ${editing.grants.includes(u.username) ? 'on' : ''}`}
                    title={u.dept ? `部门: ${u.dept}` : ''}
                    onClick={() => setEditing({ ...editing, grants: toggle(editing.grants, u.username) })}
                  >
                    {u.username}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="editor-actions">
            <button className="ask" onClick={saveEdit}>保存</button>
            <button className="del" onClick={() => setEditing(null)}>取消</button>
          </div>
          </div>
        </div>
      )}
    </div>
  )
}
