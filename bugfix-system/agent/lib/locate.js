import { git } from './git.js';

// 从 BUG 文本提取检索词：ASCII 词 + 中文 2-gram
export function extractKeywords(text) {
  const t = String(text || '').slice(0, 2000);
  const stop = /^(the|and|for|with|this|that|from|into|when|then|need|please|want|should|bug|fix|todo)$/i;
  const out = new Set();
  for (const m of t.matchAll(/[A-Za-z_][\w./-]{2,30}/g)) {
    if (!stop.test(m[0])) out.add(m[0].replace(/[./-]+$/, ''));
  }
  for (const m of t.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (run.length === 2) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out].filter(Boolean).slice(0, 40);
}

// 扩展名权重：源码优先，文档次之，数据/产物排除
const EXT_W = {
  js: 1, mjs: 1, cjs: 1, jsx: 1, ts: 1, tsx: 1, vue: 1, svelte: 1,
  css: 1, scss: 1, less: 1, html: 1, py: 1, go: 1, java: 1, sh: 0.8,
  md: 0.2,
};

// 在项目目录内按关键词定位候选文件（命中行数 × 扩展名权重排序），作为 aider 预置文件
export async function locateFiles(projDir, text, limit = 6) {
  const kws = extractKeywords(text);
  if (!kws.length) return [];
  const out = await git(projDir, 'grep', '-I', '-i', '-c',
    ...kws.flatMap((k) => ['-e', k])).catch(() => '');
  return out.split('\n').filter(Boolean)
    .map((line) => {
      const i = line.lastIndexOf(':');
      return { file: line.slice(0, i), hits: Number(line.slice(i + 1)) || 0 };
    })
    .filter((f) => f.file && !/(package-lock|dist|build|\.min\.|node_modules)/.test(f.file))
    .map((f) => {
      const ext = (f.file.match(/\.(\w+)$/) || [])[1] || '';
      return { ...f, score: f.hits * (EXT_W[ext] || 0) };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((f) => f.file);
}
