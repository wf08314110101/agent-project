import OpenAI from 'openai'
import { config } from './config.js'

// OpenAI 兼容客户端（DeepSeek）：超时 + 有限重试，防止请求挂死
export const llm = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
  timeout: 60_000,
  maxRetries: 2,
})

/**
 * 流式对话：支持工具绑定、tool_calls 分片累积、usage 提取
 * @returns {message: openai 格式 assistant 消息, usage}
 */
export async function chatStream(messages, { tools, toolChoice, signal, onDelta, temperature = 0 } = {}) {
  const stream = await llm.chat.completions.create(
    {
      model: config.llm.model,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools?.length && { tools }),
      ...(toolChoice && { tool_choice: toolChoice }),
    },
    { signal }
  )

  let content = ''
  let usage = null
  let toolCalls = []
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta
    if (d?.content) {
      content += d.content
      onDelta?.(d.content)
    }
    // tool_calls 分片：按 index 拼回完整调用（name/arguments 可能跨多个 chunk）
    if (d?.tool_calls) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0
        toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) toolCalls[i].id = tc.id
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
      }
    }
    if (chunk.usage) usage = chunk.usage
  }
  toolCalls = toolCalls.filter(Boolean)

  const message = { role: 'assistant', content: content || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  return { message, usage }
}

/** 非流式 JSON 模式调用：用于打分/改写等结构化小任务 */
export async function chatJSON(messages, { signal } = {}) {
  const res = await llm.chat.completions.create(
    {
      model: config.llm.model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    },
    { signal }
  )
  return { content: res.choices[0]?.message?.content ?? '', usage: res.usage ?? null }
}

// 模型偶发用 ```json 包裹，统一剥掉
export function parseJSON(text) {
  try {
    return JSON.parse(String(text).replace(/^```(json)?\s*|\s*```$/g, ''))
  } catch {
    return null
  }
}
