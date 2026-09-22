export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? {} : { 'content-type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

export const statusLabel = {
  submitted: '已提交', queued: '排队中', fixing: '修复中', await_confirm: '待确认',
  confirmed: '已确认', failed: '失败', rejected: '已拒绝',
  running: '修复中', awaiting_review: '待审查', approved: '待合并(已批准)', merged: '已合并',
};

export const statusColor = {
  submitted: '#8b949e', queued: '#d29922', fixing: '#58a6ff', await_confirm: '#a371f7',
  confirmed: '#3fb950', failed: '#f85149', rejected: '#8b949e',
  running: '#58a6ff', awaiting_review: '#a371f7', approved: '#d29922', merged: '#3fb950',
};

export function Badge({ status }) {
  return <span className="badge" style={{ background: statusColor[status] || '#666' }}>{statusLabel[status] || status}</span>;
}

export function timeAgo(t) {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(t).toLocaleString('zh-CN');
}
