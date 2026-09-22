import { existsSync, symlinkSync, readFileSync, writeFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { cfg } from '../../server/config.js';
import { git } from './git.js';

// 清理被杀进程遗留的 git 锁
function clearStaleLocks(dir) {
  const candidates = [
    path.join(cfg.mainRepoRoot, '.git', 'index.lock'),
    path.join(cfg.mainRepoRoot, '.git', 'worktrees', path.basename(dir), 'index.lock'),
  ];
  for (const lock of candidates) {
    try { unlinkSync(lock); } catch { /* 不存在则忽略；删不掉时由 git 报错兜底 */ }
  }
}

// 目录带 attempt 后缀：重试一律用全新目录，规避跨沙箱实例删除失败（EXDEV）
export const worktreeDir = (batchId, attempt = 0) =>
  path.resolve(cfg.worktreeRoot, `batch-${batchId}${attempt ? `-a${attempt}` : ''}`);

const markerPath = (batchId, attempt) => worktreeDir(batchId, attempt) + '.base.json';

async function defaultBranch(root) {
  try {
    const ref = await git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    return ref.replace('origin/', '');
  } catch { /* 无 remote */ }
  for (const name of ['main', 'master']) {
    try { await git(root, 'rev-parse', '--verify', name); return name; } catch { /* next */ }
  }
  return 'main';
}

// 创建（或复用）worktree，强制回到基线后返回 { dir, baseSha, branch }
// 分支被旧 worktree 占用时自动换新分支名（-a<attempt> 后缀）
export async function ensureWorktree(batchId, branch, attempt = 0) {
  const dir = worktreeDir(batchId, attempt);
  if (!existsSync(path.join(dir, '.git'))) {
    let created = false;
    try {
      await git(cfg.mainRepoRoot, 'worktree', 'add', dir, '-b', branch);
      created = true;
    } catch { /* 分支已存在或被占用 */ }
    if (!created) {
      try {
        await git(cfg.mainRepoRoot, 'worktree', 'add', dir, branch);
      } catch {
        if (!attempt) throw new Error(`worktree 创建失败：分支 ${branch} 被占用且无重试后缀`);
        branch = `${branch}-a${attempt}`;
        try { await git(cfg.mainRepoRoot, 'worktree', 'add', dir, '-b', branch); }
        catch { await git(cfg.mainRepoRoot, 'worktree', 'add', dir, branch); }
      }
    }
  }

  // 基线：优先读标记（上次记录），否则取与默认分支的 merge-base（丢弃本分支上的历史提交）
  let baseSha = null;
  try { baseSha = JSON.parse(readFileSync(markerPath(batchId, attempt), 'utf8')).baseSha; } catch { /* 首次 */ }
  if (!baseSha || !baseSha.match(/^[0-9a-f]{40}$/)) {
    const def = await defaultBranch(cfg.mainRepoRoot);
    baseSha = await git(dir, 'merge-base', 'HEAD', def)
      .catch(async () => git(dir, 'rev-parse', 'HEAD'));
  }

  // 自愈：不管目录里残留什么（垃圾提交/未跟踪文件/陈旧锁），一律打回基线
  clearStaleLocks(dir);
  await git(dir, 'reset', '--hard', baseSha);
  await git(dir, 'clean', '-fdx');
  writeFileSync(markerPath(batchId, attempt), JSON.stringify({ baseSha, branch }));
  await symlinkNodeModules(dir);
  const actualBranch = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => branch);
  return { dir, baseSha, branch: actualBranch === 'HEAD' ? branch : actualBranch };
}

// 主仓库已安装的 node_modules 通过 symlink 复用，避免 worktree 内重装依赖
async function symlinkNodeModules(wtDir) {
  const candidates = ['node_modules', 'backend/node_modules', 'frontend/node_modules'];
  for (const rel of candidates) {
    const src = path.join(cfg.mainRepoRoot, rel);
    const dst = path.join(wtDir, rel);
    if (existsSync(src) && !existsSync(dst)) {
      try { symlinkSync(src, dst); } catch { /* 竞态忽略 */ }
    }
  }
}

// 删除某批次的所有 worktree 目录 + 分支
export async function removeWorktree(batchId, { branch = null } = {}) {
  const prefix = `batch-${batchId}`;
  for (const name of readdirSync(path.resolve(cfg.worktreeRoot)).filter((n) => n === prefix || n.startsWith(prefix + '-'))) {
    const dir = path.join(path.resolve(cfg.worktreeRoot), name);
    try {
      await git(cfg.mainRepoRoot, 'worktree', 'remove', '--force', dir);
    } catch {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 留给 sweep */ }
    }
    try { rmSync(dir + '.base.json', { force: true }); } catch { /* ignore */ }
  }
  if (branch) {
    try { await git(cfg.mainRepoRoot, 'branch', '-D', branch); } catch { /* ignore */ }
  }
}

// 超过 24h 的过期 worktree 清扫
export async function sweepWorktrees() {
  const root = path.resolve(cfg.worktreeRoot);
  let names = [];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      const st = (await import('node:fs')).statSync(dir);
      if (!st.isDirectory() || Date.now() - st.mtimeMs <= 24 * 3600 * 1000) continue;
    } catch { continue; }
    try { await git(cfg.mainRepoRoot, 'worktree', 'remove', '--force', dir); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(dir + '.base.json', { force: true }); } catch { /* ignore */ }
  }
}
