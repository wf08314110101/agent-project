/**
 * 零依赖 SSE（Server-Sent Events）解码器
 *
 * 为什么要自己写：
 * 1. TCP 不保证消息边界 —— 一次 chunk 可能包含多个 SSE 帧，也可能把一个帧切成两半，
 *    所以必须维护一个 buffer，攒到出现「空行」才算一帧完整。
 * 2. UTF-8 多字节字符（中文）可能跨 chunk 被截断 —— TextDecoder 必须用 { stream: true }。
 * 3. 官方 SDK 会把这些细节全部藏起来，Demo 的目的恰恰是把它们暴露出来。
 *
 * SSE 帧格式（W3C）：
 *   event: message\n
 *   data: {"choices":[...]}\n
 *   data: 第二行\n      <- 多行 data 用 \n 拼接
 *   id: 42\n
 *   retry: 3000\n
 *   : 这是注释（常用于心跳）\n
 *   \n                  <- 空行，一帧结束并派发
 *
 * 行分隔符三种都合法：\n（LF）、\r\n（CRLF）、\r（CR）。
 */

const DEFAULT_EVENT = 'message';

/**
 * 创建一个有状态的 SSE 解码器。
 * @param {{ encoding?: string, lastEventId?: string }} [options]
 */
export function createSSEDecoder(options = {}) {
  const decoder = new TextDecoder(options.encoding);
  let buffer = '';
  let dataLines = [];
  let eventType = '';
  let lastEventId = options.lastEventId ?? '';
  let retry = null;

  /** 收齐一帧后派发；只有注释/空帧时不派发 */
  function dispatch() {
    if (dataLines.length === 0) {
      eventType = '';
      return null;
    }
    const message = {
      event: eventType || DEFAULT_EVENT,
      data: dataLines.join('\n'),
      id: lastEventId,
      retry,
    };
    dataLines = [];
    eventType = '';
    return message;
  }

  /** 解析单个帧里的所有字段行 */
  function handleFrame(frame) {
    for (const line of frame.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(':')) continue; // 注释 / 心跳，忽略

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1); // 规范允许冒号后跟一个空格

      switch (field) {
        case 'event':
          eventType = value;
          break;
        case 'data':
          dataLines.push(value);
          break;
        case 'id':
          if (!value.includes('\0')) lastEventId = value;
          break;
        case 'retry': {
          const n = Number(value);
          if (Number.isInteger(n)) retry = n;
          break;
        }
        default:
          break; // 未知字段按规范忽略，保证前向兼容
      }
    }
  }

  return {
    /**
     * 喂入一个 chunk，返回本轮解析出的完整消息数组（可能为 0 条）。
     * @param {Uint8Array|string} chunk
     * @returns {{ event: string, data: string, id: string, retry: number|null }[]}
     */
    decode(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n|\r/g, '\n');

      const messages = [];
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleFrame(frame);
        const message = dispatch();
        if (message) messages.push(message);
      }
      return messages;
    },

    /** 流结束时冲刷残留：少数服务端最后一帧不以空行结尾 */
    flush() {
      buffer += decoder.decode(); // 冲刷 TextDecoder 内部可能残留的半个字符
      const frame = buffer.replace(/\r\n|\r/g, '\n');
      buffer = '';
      if (frame.trim() === '') return [];
      handleFrame(frame);
      const message = dispatch();
      return message ? [message] : [];
    },
  };
}

/**
 * 把字节流（Web ReadableStream 或任意异步可迭代对象）转成 SSE 消息异步迭代器。
 *
 * @param {ReadableStream|AsyncIterable<Uint8Array|string>} stream
 * @param {{ encoding?: string }} [options]
 * @returns {AsyncGenerator<{ event: string, data: string, id: string, retry: number|null }>}
 */
export async function* iterateSSE(stream, options = {}) {
  const sse = createSSEDecoder(options);

  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
        yield* sse.decode(value);
      }
      yield* sse.flush();
    } finally {
      // 提前退出（break / abort / 异常）要主动取消底层流，否则连接会挂着
      if (!finished) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      }
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // Node Readable / 生成器等异步可迭代对象
  for await (const chunk of stream) yield* sse.decode(chunk);
  yield* sse.flush();
}

/**
 * TransformStream 形态：字节流进，SSE 消息出，可 pipeTo / pipeThrough。
 * @returns {TransformStream<Uint8Array, { event: string, data: string, id: string, retry: number|null }>}
 */
export function createSSETransformStream(options = {}) {
  const sse = createSSEDecoder(options);
  return new TransformStream({
    transform(chunk, controller) {
      for (const message of sse.decode(chunk)) controller.enqueue(message);
    },
    flush(controller) {
      for (const message of sse.flush()) controller.enqueue(message);
    },
  });
}
