import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { cfg } from '../../server/config.js';

const run = promisify(execFile);

const MAIN_ROOT = path.resolve(cfg.mainRepoRoot);
const WT_ROOT = path.resolve(cfg.worktreeRoot);

// 路径闸门：git 操作只允许发生在主仓库根或 worktree 根内
function guard(cwd) {
  const r = path.resolve(cwd);
  if (!r.startsWith(MAIN_ROOT + path.sep) && r !== MAIN_ROOT && !r.startsWith(WT_ROOT)) {
    throw new Error(`sandbox: 路径越界 ${r}`);
  }
  return r;
}

export async function git(cwd, ...args) {
  const safe = guard(cwd);
  const forbidden = ['push', 'remote', 'rebase', 'filter-branch', 'gc'];
  const joined = args.join(' ');
  if (forbidden.some((f) => joined === f || joined.startsWith(f + ' '))) {
    throw new Error(`sandbox: 禁止的 git 命令 ${joined}`);
  }
  // 主仓库根禁止 reset/clean（worktree 内自愈用途允许）
  if (safe === MAIN_ROOT && ['reset', 'clean'].includes(args[0])) {
    throw new Error(`sandbox: 主仓库禁止 ${joined}`);
  }
  const { stdout } = await run('git', args, { cwd: safe, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  // 只去尾部空白：porcelain 首行以状态空格开头（" M path"），trim 会破坏列对齐
  return stdout.replace(/\s+$/, '');
}

// worktree 内的文件改动列表（排除 aider 自身产物与模型幻觉产生的空文件）
export async function changedFiles(cwd) {
  const out = await git(cwd, 'status', '--porcelain');
  const { statSync } = await import('node:fs');
  return out.split('\n').filter(Boolean)
    .map((line) => ({
      path: line.slice(3).trim().replace(/^"|"$/g, ''),
      untracked: line.startsWith('??'),
    }))
    .filter((f) => !f.path.startsWith('.aider') && f.path !== '.env' && !f.path.includes('node_modules'))
    .filter((f) => {
      if (!f.untracked) return true; // 已跟踪文件的改动总是有效
      try { return statSync(`${cwd}/${f.path}`).size > 0; } catch { return false; }
    })
    .map((f) => f.path);
}
