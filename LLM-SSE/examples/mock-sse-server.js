#!/usr/bin/env node
/**
 * 本地假 LLM：完全不用 API Key 就能验证整套流式链路。
 *
 *   npm run mock        # 启动在 http://127.0.0.1:8787/v1
 *
 * 它会刻意做两件「邪恶」的事，用来检验解析器是否健壮：
 *   1. 把每个 SSE 帧随机切成 1~24 字节的碎片写入（模拟 TCP 分包，帧边界错位）
 *   2. 随机插入 `: ping` 心跳注释帧
 *
 * 对接方式：baseURL = http://127.0.0.1:8787/v1，apiKey 随便填。
 */

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANNED = [
  '当然可以。SSE（Server-Sent Events）本质上是一个永不关闭的 HTTP 响应：服务端把 Content-Type 设为 text/event-stream，然后一帧一帧往下写，每帧以空行结束。',
  '这个问题的关键在于「分包」。网络层不保证你一次读到的是一个完整帧，所以客户端必须自己攒 buffer，看到空行才认为一帧结束。中文还要额外小心 UTF-8 的三个字节被从中间劈开。',
  '简单说，流式输出把「等待 20 秒后看到全部」变成「0.4 秒看到第一个字，然后持续刷新」。对用户体感的提升，远大于它在技术实现上的复杂度。',
];

function pickAnswer(messages = []) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const base = CANNED[Math.abs(hash(last)) % CANNED.length];
  return `${base}\n\n（你问的是：${last.slice(0, 40)}${last.length > 40 ? '…' : ''}）`;
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i) | 0;
  return h;
}

/** 构造一个 SSE 帧 */
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** 随机碎片化写入，用来压测客户端的 buffer 逻辑 */
async function writeBroken(res, text) {
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(Math.random() * 24);
    res.write(text.slice(i, i + size));
    i += size;
    await sleep(4);
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('mock LLM is running. POST /v1/chat/completions with stream:true\n');
    return;
  }

  if (!req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let payload = {};
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json' } }));
    return;
  }

  // 非流式：整包返回
  if (!payload.stream) {
    const text = pickAnswer(payload.messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
      })
    );
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const answer = pickAnswer(payload.messages);
  const id = 'chatcmpl-mock';

  try {
    await writeBroken(res, frame({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));

    let completionTokens = 0;
    for (let i = 0; i < answer.length; i += 3) {
      const piece = answer.slice(i, i + 3);
      completionTokens += 1;
      await writeBroken(res, frame({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
      await sleep(30);

      if (Math.random() < 0.08) await writeBroken(res, ': ping\n\n'); // 心跳
    }

    await writeBroken(res, frame({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));

    // usage 帧：choices 是空数组 —— 客户端必须防越界
    if (payload.stream_options?.include_usage !== false) {
      await writeBroken(
        res,
        frame({
          id,
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: completionTokens, total_tokens: 12 + completionTokens },
        })
      );
    }

    await writeBroken(res, `data: [DONE]\n\n`);
  } catch {
    /* 客户端提前断开 */
  } finally {
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock LLM 已启动：http://127.0.0.1:${PORT}/v1`);
});
