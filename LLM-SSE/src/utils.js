import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 最小 .env 加载器。Node 20.12+ 走内置 process.loadEnvFile，
 * 老版本用正则兜底。已存在的环境变量不会被覆盖。
 * @param {string} [file] 默认当前工作目录下的 .env
 * @returns {boolean} 是否成功加载
 */
export function loadEnvIfExists(file = '.env') {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return false;

  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(path);
      return true;
    } catch {
      /* 解析失败时退回手写解析 */
    }
  }

  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue = ''] = match;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/** 把秒数格式化成人类可读耗时 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 计算 tokens/s（首 token 延迟之后的生成速度） */
export function formatSpeed(tokens, ms) {
  if (!tokens || !ms) return '-';
  return `${(tokens / (ms / 1000)).toFixed(1)} tok/s`;
}
