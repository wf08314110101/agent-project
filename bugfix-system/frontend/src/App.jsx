import React, { useEffect, useState } from 'react';
import { api, Badge, timeAgo } from './api.jsx';

const useHash = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const fn = () => setHash(location.hash);
    addEventListener('hashchange', fn);
    return () => removeEventListener('hashchange', fn);
  }, []);
  return hash;
};
const nav = (h) => { location.hash = h; };

/* ---------- 提交 BUG ---------- */
function SubmitForm({ projects, onDone }) {
  const [form, setForm] = useState({ project_id: '', title: '', description: '', severity: 'P2', related_group: '' });
  const [files, setFiles] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => v && fd.append(k, v));
      files.forEach((f) => fd.append('screenshots', f));
      await api('/api/bugs', { method: 'POST', body: fd });
      setForm({ project_id: '', title: '', description: '', severity: 'P2', related_group: '' });
      setFiles([]);
      setMsg('✓ 已提交');
      onDone?.();
    } catch (err) { setMsg('✗ ' + err.message); }
    setBusy(false);
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>提交 BUG</h3>
      <div className="row">
        <select required value={form.project_id} onChange={set('project_id')}>
          <option value="">选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={form.severity} onChange={set('severity')}>
          {['P1', 'P2', 'P3', 'P4'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <input placeholder="关联组（可选，关联 BUG 一起修）" value={form.related_group} onChange={set('related_group')} />
      </div>
      <input required placeholder="BUG 标题" value={form.title} onChange={set('title')} />
      <textarea rows={5} placeholder="复现步骤 / 期望结果 / 实际结果" value={form.description} onChange={set('description')} />
      <input type="file" accept="image/*" multiple onChange={(e) => setFiles([...e.target.files].slice(0, 10))} />
      <div className="row">
        <button disabled={busy}>{busy ? '提交中…' : '提交 BUG'}</button>
        <span className="muted">{msg}</span>
      </div>
    </form>
  );
}

/* ---------- BUG 列表 ---------- */
function BugList({ projects }) {
  const [bugs, setBugs] = useState([]);
  const [filter, setFilter] = useState({});
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    setBugs(await api('/api/bugs?' + qs));
  };
  useEffect(() => { load().catch(console.error); }, [filter]);
  useEffect(() => {
    const t = setInterval(() => load().catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [filter]);

  return (
    <div className="card">
      <div className="row">
        <h3>BUG 列表</h3>
        <select value={filter.project_id || ''} onChange={(e) => setFilter({ ...filter, project_id: e.target.value })}>
          <option value="">全部项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <table>
        <thead><tr><th>#</th><th>标题</th><th>项目</th><th>级别</th><th>状态</th><th>截图</th><th>提交时间</th></tr></thead>
        <tbody>
          {bugs.map((b) => (
            <tr key={b.id} onClick={() => nav(`/bug/${b.id}`)} className="clickable">
              <td>{b.id}</td>
              <td>{b.title}</td>
              <td>{b.project_name}</td>
              <td>{b.severity}</td>
              <td><Badge status={b.status} /></td>
              <td>{b.attachment_count || 0}</td>
              <td className="muted">{timeAgo(b.created_at)}</td>
            </tr>
          ))}
          {!bugs.length && <tr><td colSpan={7} className="muted">暂无 BUG</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- BUG 详情 ---------- */
function BugDetail({ id }) {
  const [bug, setBug] = useState(null);
  useEffect(() => { api(`/api/bugs/${id}`).then(setBug).catch(console.error); }, [id]);

  if (!bug) return <p className="muted">加载中…</p>;
  const batch = bug.batches?.[0];
  const fix = bug.fixes?.[0];
  return (
    <div className="card">
      <button onClick={() => nav('/')}>← 返回</button>
      <h3>BUG-{bug.id} {bug.title} <Badge status={bug.status} /></h3>
      <p className="muted">项目 {bug.project_name} · {bug.severity} · {timeAgo(bug.created_at)}
        {bug.fail_reason && <span className="danger"> · {bug.fail_reason}</span>}</p>
      <pre className="desc">{bug.description || '（无描述）'}</pre>
      {bug.attachments?.length > 0 && (
        <div className="imgs">
          {bug.attachments.map((a) => <img key={a.id} src={`/api/attachments/${a.id}`} alt={a.filename} />)}
        </div>
      )}
      {batch && (
        <p>批次 <a href={`#/batch/${batch.id}`}>#{batch.id}</a> <Badge status={batch.status} /></p>
      )}
      {fix && (
        <>
          <h4>修复记录 <code>{fix.commit_sha?.slice(0, 8)}</code></h4>
          <p><b>根因:</b> {fix.root_cause}</p>
          <p><b>方案:</b> {fix.summary}</p>
          <p className="muted">改动文件: {(fix.fixed_files || []).join(', ')}</p>
          {fix.diff && <details><summary>查看 diff</summary><pre className="diff">{fix.diff}</pre></details>}
        </>
      )}
    </div>
  );
}

/* ---------- 批次审查 ---------- */
function BatchDetail({ id }) {
  const [batch, setBatch] = useState(null);
  const [msg, setMsg] = useState('');
  const load = () => api(`/api/batches/${id}`).then(setBatch).catch(console.error);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [id]);
  if (!batch) return <p className="muted">加载中…</p>;

  const act = async (path, body) => {
    try { await api(`/api/batches/${id}/${path}`, { method: 'POST', body }); setMsg('✓ 已执行'); load(); }
    catch (e) { setMsg('✗ ' + e.message); }
  };
  const testFailed = batch.report?.test_output?.startsWith('FAIL');
  const canReview = ['awaiting_review', 'approved'].includes(batch.status);

  return (
    <div className="card">
      <button onClick={() => nav('/')}>← 返回</button>
      <h3>批次 #{batch.id} <Badge status={batch.status} /></h3>
      <p className="muted">项目 {batch.project_name} · 分支 <code>{batch.branch}</code>
        {batch.error && <span className="danger"> · {batch.error}</span>}</p>
      <p>{batch.bugs?.map((b) => (
        <span key={b.id} className="pill">BUG-{b.id} {b.title}</span>
      ))}</p>

      {batch.report?.test_output && (
        <details open={testFailed}>
          <summary>回归测试 {testFailed ? <b className="danger">未通过</b> : '输出'}</summary>
          <pre className="diff">{batch.report.test_output}</pre>
        </details>
      )}

      {batch.fixes?.map((f) => (
        <div key={f.id} className="fixblock">
          <h4>BUG-{f.bug_id} 修复 <code>{f.commit_sha?.slice(0, 8)}</code></h4>
          <p><b>根因:</b> {f.root_cause}</p>
          <p><b>方案:</b> {f.summary}</p>
          <p className="muted">文件: {(f.fixed_files || []).join(', ')}</p>
          {f.diff && <details><summary>diff</summary><pre className="diff">{f.diff}</pre></details>}
        </div>
      ))}

      {batch.traces?.length > 0 && (
        <details><summary>修复过程 trace（{batch.traces.length} 步）</summary>
          <div className="timeline">
            {batch.traces.map((t) => (
              <div key={t.id}>
                <code>{t.step}</code> <span className="muted">{timeAgo(t.created_at)}</span>
                <pre>{JSON.stringify(t.payload, null, 2)?.slice(0, 2000)}</pre>
              </div>
            ))}
          </div>
        </details>
      )}

      {canReview && (
        <div className="row actions">
          {batch.status === 'awaiting_review' && <button className="primary" onClick={() => act('approve', {})}>批准 → 由 Agent 合并</button>}
          <button onClick={() => act('mark-merged', {})}>标记已手动合并</button>
          <button className="danger" onClick={() => {
            const reason = prompt('拒绝原因（可选）') || '';
            act('reject', { reason });
          }}>拒绝</button>
        </div>
      )}
      <span className="muted">{msg}</span>
    </div>
  );
}

/* ---------- 批次列表 ---------- */
function BatchList() {
  const [batches, setBatches] = useState([]);
  const load = () => api('/api/batches').then(setBatches).catch(console.error);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  return (
    <div className="card">
      <h3>修复批次</h3>
      <table>
        <thead><tr><th>#</th><th>项目</th><th>分支</th><th>状态</th><th>BUG</th><th>创建时间</th></tr></thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} onClick={() => nav(`/batch/${b.id}`)} className="clickable">
              <td>{b.id}</td>
              <td>{b.project_name}</td>
              <td><code>{b.branch}</code></td>
              <td><Badge status={b.status} /></td>
              <td>{(b.bugs || []).map((x) => `#${x.id}`).join(',')}</td>
              <td className="muted">{timeAgo(b.created_at)}</td>
            </tr>
          ))}
          {!batches.length && <tr><td colSpan={6} className="muted">暂无批次</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const hash = useHash();
  const [projects, setProjects] = useState([]);
  useEffect(() => { api('/api/projects').then(setProjects).catch(console.error); }, []);

  const bugMatch = hash.match(/^#\/bug\/(\d+)$/);
  const batchMatch = hash.match(/^#\/batch\/(\d+)$/);
  let view;
  if (bugMatch) view = <BugDetail id={bugMatch[1]} />;
  else if (batchMatch) view = <BatchDetail id={batchMatch[1]} />;
  else if (hash === '#/batches') view = <BatchList />;
  else view = (
    <>
      <SubmitForm projects={projects} />
      <BugList projects={projects} />
    </>
  );

  return (
    <div className="wrap">
      <header>
        <h1>BugFix <span className="muted">自动修复系统</span></h1>
        <nav>
          <a href="#/">BUG 列表</a>
          <a href="#/batches">修复批次</a>
        </nav>
      </header>
      {view}
    </div>
  );
}
