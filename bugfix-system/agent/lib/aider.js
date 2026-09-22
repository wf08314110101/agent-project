import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { cfg } from '../../server/config.js';

function aiderBin() {
  for (const p of ['aider', path.join(homedir(), '.local/bin/aider')]) {
    if (existsSync(p) || !p.includes('/')) return p;
  }
  return 'aider';
}

// 在 worktree 内驱动 aider 修复，返回模型输出文本
export function runAider(cwd, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      '--model', cfg.aiderModel,
      '--edit-format', cfg.aiderEditFormat,
      '--message', prompt,
      '--yes-always',
      '--no-auto-commits',
      '--no-suggest-shell-commands',
      '--no-gitignore',
      '--no-check-update',
      '--no-show-model-warnings',
      '--no-pretty',
      '--openai-api-base', cfg.openaiApiBase,
    ];
    const child = spawn(aiderBin(), args, {
      cwd,
      env: { ...process.env, OPENAI_API_KEY: cfg.openaiApiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`aider 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.length > 0) resolve((out + '\n' + err).slice(-12000));
      else reject(new Error(`aider 退出码 ${code}: ${err.slice(-500)}`));
    });
  });
}

// 从模型输出中提取最后一段 ```json 块
export function parseResultJson(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  try { return JSON.parse(blocks[blocks.length - 1][1]); } catch { return null; }
}
