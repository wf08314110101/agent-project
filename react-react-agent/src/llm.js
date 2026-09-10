import { tools } from './tools'

const CFG = {
  apiBase: '/api/v1', // 走 vite proxy，避免浏览器 CORS；生产改为后端真实地址
  model: 'deepseek-chat', // 你的 DS v4 flash 模型 id
  apiKey: import.meta.env.VITE_API_KEY ?? 'sk-xxxxxx', // 推荐 .env 注入
}

export const LLM_MODEL = CFG.model // 供观测层（Langfuse Generation）标注模型名

/**
 * 真实流式调用 LLM（stream: true，SSE）。
 * @param o.onDelta (text, type) 逐 token 回调，即时打印
 * @param o.signal AbortController，支持中途停止
 * @returns { role, content, tool_calls, usage: { prompt_tokens, completion_tokens, total_tokens } }
 */
export async function callLLMStream(messages, { onDelta, signal } = {}) {
  const res = await fetch(`${CFG.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CFG.apiKey}`,
    },
    body: JSON.stringify({
      model: CFG.model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0,
      stream: true,
      // 标准做法：流结束前把 usage 通过 SSE 主体推过来（比自定义 header 可靠）
      stream_options: { include_usage: true },
    }),
    signal,
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)

  // usage 优先读 SSE 主体（include_usage 帧）；headers 仅做兜底（代理常吞掉 x-* 头）
  const usage = {
    prompt_tokens: +(res.headers.get('x-prompt-tokens') ?? 0),
    completion_tokens: +(res.headers.get('x-completion-tokens') ?? 0),
    total_tokens: +(res.headers.get('x-total-tokens') ?? 0),
  }

  // ---- 读取 SSE 流：response.body 是 ReadableStream ----
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCalls = {}

  const flush = async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (data === '[DONE]') return
        const json = JSON.parse(data)

        // ⭐ 流量结束前的 usage 帧：choices 为空、无 delta，先读它再 continue
        if (json.usage) {
          usage.prompt_tokens = json.usage.prompt_tokens ?? usage.prompt_tokens
          usage.completion_tokens = json.usage.completion_tokens ?? usage.completion_tokens
          usage.total_tokens = json.usage.total_tokens ?? usage.total_tokens
        }

        const delta = json.choices?.[0]?.delta
        if (!delta) continue

        if (delta.content) {
          content += delta.content
          onDelta?.(delta.content, 'content')
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            // started 标记：name 首次出现时先补换行+前缀，避免工具名粘连正文/其他工具
            toolCalls[idx] ??= { id: '', started: false, function: { name: '', arguments: '' } }
            const slot = toolCalls[idx]
            if (tc.id) slot.id += tc.id // id 不显示（太长且无意义），仅累积供配对
            if (tc.function?.name) {
              if (!slot.started) {
                onDelta?.(`, 调用工具 `, 'action') // 工具名前缀
                slot.started = true
              }
              slot.function.name += tc.function.name
              onDelta?.(tc.function.name, 'tool') // ⭐ 流式逐字显示工具名
            }
            if (tc.function?.arguments) {
              slot.function.arguments += tc.function.arguments // 增量 JSON 累积，稍后完整补打
            }
          }
        }
      }
    }
  }

  await flush()

  const calls = Object.values(toolCalls).map((c) => ({
    id: c.id,
    type: 'function',
    function: c.function,
  }))
  return {
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
    usage, // 本轮 token 消耗回传给 agent
  }
}