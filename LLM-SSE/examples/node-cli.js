#!/usr/bin/env node
/**
 * 终端打字机 Demo：三步配置 + 多轮对话 + 流式输出 + Ctrl+C 中断
 *
 *   node examples/node-cli.js                 三步配置（选厂商 → 选模型 → 填 Key）后进入对话
 *   node examples/node-cli.js "写一句自我介绍"  单次提问后退出（需要有 .env 配置）
 *   node examples/node-cli.js --setup          强制重新走一遍配置向导
 *
 * 对话中命令：/setup 重新配置  /clear 清空上下文  /messages 查看上下文  /exit 退出
 */

import { stdin as input, stdout as output } from 'node:process';
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { ChatSession } from '../src/chat-session.js';
import { loadEnvIfExists, formatDuration, formatSpeed } from '../src/utils.js';
import {
  PROVIDERS,
  getProvider,
  findProviderByBaseURL,
  isKeyRequired,
  CUSTOM_PROVIDER_ID,
} from '../src/providers.js';

loadEnvIfExists();

const SYSTEM_PROMPT = '你是一个简洁、直接的中文助手。';

/** 当前会话，/setup 后会重建 */
let session = null;
/** 当前正在进行的请求，供 Ctrl+C 中断 */
let currentController = null;

/* --------------------------------- 输入 --------------------------------- */

/**
 * 把 readline 的 line 事件包装成「问一句等一行」。
 * 不用 rl.question() 的原因：它一次只消费一行，管道输入时剩余行会被丢弃。
 * @param {readline.Interface} rl
 * @returns {(prompt: string) => Promise<string|null>} 输入流关闭时返回 null
 */
function createAsker(rl) {
  const queue = [];
  let waiting = null;

  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    if (waiting) waiting(null);
  });

  return (prompt) => {
    output.write(prompt);
    return new Promise((resolve) => {
      if (queue.length) resolve(queue.shift());
      else waiting = resolve;
    });
  };
}

/* --------------------------------- 配置 --------------------------------- */

function readConfigFromEnv() {
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!baseURL && !apiKey) return null;
  const provider = findProviderByBaseURL(baseURL) || getProvider(CUSTOM_PROVIDER_ID);
  return {
    providerId: provider.id,
    providerName: provider.name,
    baseURL: baseURL || provider.baseURL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || provider.defaultModel || '',
    apiKey: apiKey || '',
  };
}

function createSession(cfg) {
  return new ChatSession({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 10,
  });
}

const maskKey = (k) => (k.length > 12 ? `${k.slice(0, 6)}****${k.slice(-4)}` : '****');

function printConfig(cfg) {
  console.log(
    `\n当前配置：${cfg.providerName || cfg.providerId} | ${cfg.baseURL} | ${cfg.model || '(未选模型)'} | Key ${
      cfg.apiKey ? maskKey(cfg.apiKey) : '(未设置)'
    }`
  );
}

async function chooseProvider(ask, prev) {
  const defIdx = Math.max(
    0,
    PROVIDERS.findIndex((p) => p.id === prev.providerId)
  );
  console.log('\n第 1 步 / 选择大模型厂商');
  PROVIDERS.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name}${p.baseURL ? `  →  ${p.baseURL}` : ''}${i === defIdx ? '  (默认)' : ''}`);
  });
  const ans = (await ask(`请输入序号 [${defIdx + 1}]: `))?.trim() ?? '';
  const n = Number(ans);
  if (ans && Number.isInteger(n) && n >= 1 && n <= PROVIDERS.length) return PROVIDERS[n - 1];
  return PROVIDERS[defIdx];
}

async function chooseModel(ask, provider, prevModel) {
  console.log('\n第 2 步 / 选择模型');
  if (!provider.models.length) {
    const hint = provider.modelPlaceholder ? `（形如 ${provider.modelPlaceholder}）` : '';
    return ((await ask(`请输入模型名${hint}: `)) ?? '').trim();
  }
  const defIdx = Math.max(0, provider.models.indexOf(prevModel));
  provider.models.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m}${i === defIdx ? '  (默认)' : ''}`);
  });
  const ans = ((await ask(`请输入序号 [${defIdx + 1}]，或直接输入模型名: `)) ?? '').trim();
  if (!ans) return provider.models[defIdx];
  const n = Number(ans);
  if (Number.isInteger(n) && n >= 1 && n <= provider.models.length) return provider.models[n - 1];
  return ans; // 不是数字就当模型名
}

async function chooseKey(ask, provider, baseURL) {
  console.log('\n第 3 步 / 输入 API Key');
  if (!isKeyRequired(provider) || /localhost|127\.0\.0\.1/.test(baseURL)) {
    console.log('  该服务无需 Key，已跳过。');
    return '';
  }
  if (provider.keyUrl) console.log(`  申请地址：${provider.keyUrl}`);
  return ((await ask('  API Key（明文显示，直接回车则跳过）: ')) ?? '').trim();
}

async function maybeSaveEnv(ask, cfg) {
  const ans = ((await ask('\n是否写入 .env 以便下次免配置？(y/N): ')) ?? '').trim().toLowerCase();
  if (ans !== 'y' && ans !== 'yes') return;
  writeFileSync(
    '.env',
    [
      `OPENAI_BASE_URL=${cfg.baseURL}`,
      `OPENAI_MODEL=${cfg.model}`,
      `OPENAI_API_KEY=${cfg.apiKey}`,
      `OPENAI_SYSTEM_PROMPT=${SYSTEM_PROMPT}`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  console.log('  已写入 .env（权限 600）');
}

async function runWizard(ask, prev = {}) {
  console.log('\n=== LLM-SSE 配置向导 ===');

  const provider = await chooseProvider(ask, prev);
  let baseURL = provider.baseURL;
  if (provider.custom || !baseURL) {
    baseURL = ((await ask('\n第 1 步 / 填写 baseURL（例：http://localhost:8787/v1）: ')) ?? '').trim();
  }
  if (provider.note) console.log(`\n  提示：${provider.note}`);

  const model = await chooseModel(ask, provider, prev.model);
  const apiKey = await chooseKey(ask, provider, baseURL);

  const cfg = { providerId: provider.id, providerName: provider.name, baseURL, model, apiKey };
  printConfig(cfg);
  return cfg;
}

/* --------------------------------- 对话 --------------------------------- */

async function run(question) {
  const controller = new AbortController();
  currentController = controller;

  const startedAt = Date.now();
  let firstTokenAt = 0;

  try {
    const result = await session.send(question, {
      signal: controller.signal,
      onDelta: (delta) => {
        if (!firstTokenAt) firstTokenAt = Date.now();
        output.write(delta); // 打字机：拿到一个 delta 就写一个
      },
    });

    const total = Date.now() - startedAt;
    const completion = result.usage?.completion_tokens;
    const stats = [
      result.aborted ? '已中断' : result.finishReason || 'done',
      firstTokenAt ? `首 token ${formatDuration(firstTokenAt - startedAt)}` : null,
      `耗时 ${formatDuration(total)}`,
      completion ? `${completion} tokens · ${formatSpeed(completion, total)}` : null,
    ].filter(Boolean);

    output.write(`\n\n  ── ${stats.join(' · ')} ──\n`);
  } catch (err) {
    output.write(`\n  [错误] ${err.message}\n`);
    if (err.status) output.write(`  [HTTP ${err.status}] ${err.code || ''}\n`);
    if (err.cause?.code) output.write(`  [${err.cause.code}] ${err.cause.message || ''}\n`);
  } finally {
    currentController = null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const oneShot = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
  const forceSetup = argv.includes('--setup');

  // 单次提问模式：必须有现成配置
  if (oneShot) {
    const cfg = readConfigFromEnv();
    if (!cfg || !cfg.model) {
      console.error('尚未配置。请先执行 npm run cli 走一遍三步配置，或复制 .env.example 为 .env。');
      process.exit(1);
    }
    printConfig(cfg);
    session = createSession(cfg);
    await run(oneShot);
    return;
  }

  const rl = readline.createInterface({ input, output });
  const ask = createAsker(rl);
  rl.on('SIGINT', () => {
    if (currentController) {
      currentController.abort();
      output.write('\n[已中断]\n');
    } else {
      output.write('\n再见\n');
      rl.close();
    }
  });

  let cfg = forceSetup ? null : readConfigFromEnv();
  if (cfg && !cfg.model) cfg = null;
  if (cfg) {
    printConfig(cfg);
    console.log('（输入 /setup 可重新选择厂商与模型）');
  } else {
    cfg = await runWizard(ask);
    await maybeSaveEnv(ask, cfg);
  }
  session = createSession(cfg);

  console.log('\n输入问题回车发送；生成中按 Ctrl+C 中断；/setup 重新配置；/exit 退出。');

  while (true) {
    const line = await ask('\n你 > ');
    if (line === null) break; // 输入流关闭
    const question = line.trim();
    if (!question) continue;
    if (question === '/exit' || question === '/quit') break;
    if (question === '/clear') {
      session.clear();
      output.write('[上下文已清空]\n');
      continue;
    }
    if (question === '/messages') {
      console.log(session.getMessages());
      continue;
    }
    if (question === '/setup') {
      cfg = await runWizard(ask, cfg);
      await maybeSaveEnv(ask, cfg);
      session = createSession(cfg);
      continue;
    }

    output.write('助手 > ');
    await run(question);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
