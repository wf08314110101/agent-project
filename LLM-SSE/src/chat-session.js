/**
 * 多轮对话会话：维护 messages 数组，自动把上下文带进下一次请求。
 */

import { chatStream } from './llm-client.js';

export class ChatSession {
  /**
   * @param {object} options
   * @param {string} [options.systemPrompt]     系统提示词
   * @param {number} [options.maxTurns=20]      保留的最近轮数（超出后丢弃最早的对话）
   * @param {object} [options.clientOptions]    透传给 chatStream：baseURL / apiKey / model ...
   */
  constructor({ systemPrompt, maxTurns = 20, ...clientOptions } = {}) {
    this.clientOptions = clientOptions;
    this.maxTurns = maxTurns;
    this.messages = [];
    if (systemPrompt) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
  }

  /** 当前上下文快照（只读用途，返回副本） */
  getMessages() {
    return this.messages.map((m) => ({ ...m }));
  }

  /** 整体替换上下文（切换厂商/模型后想保留历史时用） */
  setMessages(messages) {
    this.messages = messages.map((m) => ({ ...m }));
  }

  /** 切换厂商 / 模型 / Key，保留已有上下文 */
  updateConfig(patch) {
    this.clientOptions = { ...this.clientOptions, ...patch };
    return this;
  }

  clear() {
    const system = this.messages.filter((m) => m.role === 'system');
    this.messages = system;
  }

  /**
   * 发送一条用户消息并流式接收。
   * @param {string} input
   * @param {{ onDelta?: (delta: string, text: string) => void, signal?: AbortSignal }} [options]
   * @returns {Promise<{ text: string, usage: object|null, finishReason: string|null, aborted: boolean }>}
   */
  async send(input, { onDelta, signal } = {}) {
    const content = String(input ?? '').trim();
    if (!content) throw new Error('输入不能为空');

    this.messages.push({ role: 'user', content });

    let result = { text: '', usage: null, finishReason: null, aborted: false };
    try {
      for await (const event of chatStream({
        ...this.clientOptions,
        messages: this.messages,
        signal,
      })) {
        if (event.type === 'delta') {
          onDelta?.(event.delta, event.text);
        } else if (event.type === 'done') {
          result = {
            text: event.text,
            usage: event.usage,
            finishReason: event.finishReason,
            aborted: false,
          };
        }
      }
    } catch (err) {
      // 用户主动中断：已生成的部分照样入上下文，避免对话断层
      if (err?.name === 'AbortError') {
        result.aborted = true;
      } else {
        this.messages.pop(); // 失败的请求不污染上下文
        throw err;
      }
    }

    if (result.text) {
      this.messages.push({ role: 'assistant', content: result.text });
      this.#trim();
    } else {
      this.messages.pop();
    }
    return result;
  }

  /** 只保留 system + 最近 maxTurns 轮（1 轮 = 1 user + 1 assistant） */
  #trim() {
    const system = this.messages.filter((m) => m.role === 'system');
    const rest = this.messages.filter((m) => m.role !== 'system');
    const keep = this.maxTurns * 2;
    this.messages = [...system, ...rest.slice(Math.max(0, rest.length - keep))];
  }
}
