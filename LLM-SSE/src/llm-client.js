/**
 * OpenAI / OpenAI 兼容接口的流式客户端（零依赖）
 *
 * 只做一件事：POST /v1/chat/completions 且 stream: true，
 * 把 SSE 帧还原成「增量文本」事件，并妥善处理各种真实世界的脏数据。
 */

import { iterateSSE } from './sse-parser.js';

/** 服务端结束标记（部分厂商会带尾随空格，所以比较前一律 trim） */
const DONE_SIGNAL = '[DONE]';

/** 浏览器里没有 process，这里做安全读取 */
const readEnv = (key) =>
  typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

export class LLMError extends Error {
  constructor(message, { status, code, type, response } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.response = response;
  }
}

function joinUrl(baseURL, path) {
  return `${String(baseURL || '').replace(/\/+$/, '')}${path}`;
}

async function parseErrorResponse(res) {
  let raw = '';
  let payload = null;
  try {
    raw = await res.text();
    payload = JSON.parse(raw);
  } catch {
    /* 非 JSON 错误体（代理/网关常見的 HTML 报错），保留原文 */
  }
  const error = payload?.error ?? {};
  return new LLMError(error.message || raw || `HTTP ${res.status} ${res.statusText}`, {
    status: res.status,
    code: error.code,
    type: error.type,
    response: payload ?? raw,
  });
}

function buildHeaders(apiKey, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    // 提示 Nginx 一类反代不要缓冲（配合服务端 proxy_buffering off 使用）
    'X-Accel-Buffering': 'no',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { ...headers, ...extra };
}

function buildBody({
  model,
  messages,
  temperature,
  maxTokens,
  topP,
  stop,
  streamOptions,
  extraBody,
}) {
  const body = { model, messages, stream: true };
  if (temperature != null) body.temperature = temperature;
  if (maxTokens != null) body.max_tokens = maxTokens;
  if (topP != null) body.top_p = topP;
  if (stop != null) body.stop = stop;
  // 只有显式传了 stream_options 才会带上 usage；设成 null 可关闭（部分兼容方不认这个字段）
  if (streamOptions !== null) {
    body.stream_options = streamOptions ?? { include_usage: true };
  }
  return { ...body, ...extraBody };
}

/**
 * 流式对话。
 *
 * @param {object} options
 * @param {string} [options.baseURL]        兼容接口地址，如 https://api.deepseek.com/v1
 * @param {string} [options.apiKey]
 * @param {string} [options.model]
 * @param {{role:string,content:string}[]} options.messages
 * @param {AbortSignal} [options.signal]    用于中断（停止生成）
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {AsyncGenerator<
 *   { type:'delta', delta:string, text:string } |
 *   { type:'done', text:string, usage:object|null, finishReason:string|null, id:string }
 * >}
 */
export async function* chatStream(options = {}) {
  const {
    baseURL = readEnv('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    apiKey = readEnv('OPENAI_API_KEY'),
    model = readEnv('OPENAI_MODEL') || 'gpt-4o-mini',
    messages,
    temperature,
    maxTokens,
    topP,
    stop,
    streamOptions = { include_usage: true },
    extraBody,
    signal,
    headers,
    fetchImpl = globalThis.fetch,
  } = options;

  if (!fetchImpl) throw new LLMError('当前环境没有 fetch，请通过 fetchImpl 传入实现');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LLMError('messages 不能为空');
  }

  const res = await fetchImpl(joinUrl(baseURL, '/chat/completions'), {
    method: 'POST',
    headers: buildHeaders(apiKey, headers),
    body: JSON.stringify(
      buildBody({ model, messages, temperature, maxTokens, topP, stop, streamOptions, extraBody })
    ),
    signal,
  });

  // 关键点：出错时响应体是普通 JSON，不是 SSE，必须先判 status 再决定怎么读
  if (!res.ok) throw await parseErrorResponse(res);
  if (!res.body) throw new LLMError('响应没有可读流（res.body 为空）');

  const contentType = res.headers.get('content-type') || '';
  // 少数网关会忽略 stream 参数，直接返回整包 JSON，这里兜底处理
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const json = await res.json();
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? '';
    yield { type: 'delta', delta: text, text };
    yield {
      type: 'done',
      text,
      usage: json.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
      id: json.id ?? '',
    };
    return;
  }

  let text = '';
  let usage = null;
  let finishReason = null;
  let id = '';

  for await (const event of iterateSSE(res.body)) {
    if (event.event === 'error') {
      // 部分服务用 event: error 帧报告流中断
      throw new LLMError(event.data || '服务端返回 error 事件', { type: 'stream_error' });
    }

    const raw = event.data.trim();
    if (raw === '') continue; // 心跳注释帧
    if (raw === DONE_SIGNAL) break;

    let chunk;
    try {
      chunk = JSON.parse(raw);
    } catch {
      continue; // 脏帧（代理插的日志等），跳过而不是让整个流崩掉
    }

    if (chunk.error) {
      throw new LLMError(chunk.error.message || '流中返回错误', {
        code: chunk.error.code,
        type: chunk.error.type,
      });
    }
    if (chunk.id) id = chunk.id;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue; // usage 帧的 choices 是空数组，必须防越界
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta?.content ?? '';
    if (delta) {
      text += delta;
      yield { type: 'delta', delta, text };
    }
  }

  yield { type: 'done', text, usage, finishReason, id };
}

/**
 * 非流式对话，用于和流式做对比，或做一次性调用。
 * @returns {Promise<{ text:string, usage:object|null, finishReason:string|null, raw:object }>}
 */
export async function chat(options = {}) {
  const {
    baseURL = readEnv('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    apiKey = readEnv('OPENAI_API_KEY'),
    model = readEnv('OPENAI_MODEL') || 'gpt-4o-mini',
    messages,
    temperature,
    maxTokens,
    signal,
    headers,
    extraBody,
    fetchImpl = globalThis.fetch,
  } = options;

  if (!fetchImpl) throw new LLMError('当前环境没有 fetch，请通过 fetchImpl 传入实现');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LLMError('messages 不能为空');
  }

  const res = await fetchImpl(joinUrl(baseURL, '/chat/completions'), {
    method: 'POST',
    headers: buildHeaders(apiKey, headers),
    body: JSON.stringify(
      buildBody({
        model,
        messages,
        temperature,
        maxTokens,
        streamOptions: null,
        extraBody: { ...extraBody, stream: false },
      })
    ),
    signal,
  });
  if (!res.ok) throw await parseErrorResponse(res);

  const json = await res.json();
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    usage: json.usage ?? null,
    finishReason: choice?.finish_reason ?? null,
    raw: json,
  };
}

/** 工厂：固定 baseURL / apiKey / model，避免每处重复传 */
export function createClient(defaults = {}) {
  return {
    stream: (options = {}) => chatStream({ ...defaults, ...options }),
    chat: (options = {}) => chat({ ...defaults, ...options }),
  };
}
