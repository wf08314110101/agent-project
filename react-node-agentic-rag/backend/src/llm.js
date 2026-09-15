// ============================================================================
// LLM 封装层：基于 OpenAI 兼容协议（默认 DeepSeek）的两种调用方式
// ----------------------------------------------------------------------------
// chatStream     : 流式对话（支持工具绑定）→ Agent 主循环使用
// chatStructured : 结构化输出（tool-call 强制 + schema 校验自纠）→ 子图打分/改写
// ============================================================================

import OpenAI from 'openai'
import { config } from './config.js'
import { validateSchema } from './schema.js'

// OpenAI 兼容客户端（DeepSeek）：超时 + 有限重试，防止请求挂死
export const llm = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
  timeout: 60_000, // 单次请求 60s 超时
  maxRetries: 2,   // 网络类错误自动重试 2 次
})

/**
 * 流式对话：支持工具绑定、tool_calls 分片累积、usage 提取
 *
 * @param {Array} messages - OpenAI 格式的消息数组（system/user/assistant/tool）
 * @param {Object} opts
 *   - tools       : 工具 JSON Schema 定义数组（不传则纯对话）
 *   - toolChoice  : 'none' 等强制策略（如超轮数时禁用工具）
 *   - signal      : AbortSignal，客户端断开时中断上游请求
 *   - onDelta     : 每收到一段正文 token 的回调（用于 SSE 转发给前端）
 *   - temperature : 采样温度，默认 0（RAG 场景要稳定，不要发散）
 * @returns {{ message: object, usage: object|null }}
 *   message 为拼装完整的 assistant 消息（含 tool_calls 时一并带回）；
 *   usage 为 token 用量统计（stream_options 开启后最后一个 chunk 会携带）
 */
export async function chatStream(messages, { tools, toolChoice, signal, onDelta, temperature = 0 } = {}) {
  // 发起流式请求；`...(tools?.length && { tools })` 为条件展开：无工具时不多传字段
  const stream = await llm.chat.completions.create(
    {
      model: config.llm.model,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true }, // 流式模式下也返回 token 用量
      ...(tools?.length && { tools }),
      ...(toolChoice && { tool_choice: toolChoice }),
    },
    { signal }
  )

  let content = ''    // 正文增量累积
  let usage = null    // token 用量（最后一个 chunk 携带）
  let toolCalls = []  // 按索引槽位累积的工具调用
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta
    if (d?.content) {
      content += d.content
      onDelta?.(d.content) // 边收边转发，前端实现打字机效果
    }
    // tool_calls 分片：按 index 拼回完整调用（name/arguments 可能跨多个 chunk）
    // 例如 arguments 是 JSON 字符串，会被拆成多段逐字下发，这里按序拼接
    if (d?.tool_calls) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0 // 无 index 视为第 0 个调用
        toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) toolCalls[i].id = tc.id
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
      }
    }
    if (chunk.usage) usage = chunk.usage
  }
  toolCalls = toolCalls.filter(Boolean) // 清理稀疏数组的空洞

  // 拼装最终 assistant 消息：有工具调用则挂上 tool_calls，无正文则置 null（符合 OpenAI 规范）
  const message = { role: 'assistant', content: content || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  return { message, usage }
}

/**
 * 结构化输出：tool-call 强制（OpenAI 兼容 API 支持面最广）+ 客户端 schema 校验 + 失败自纠一轮
 *
 * 为什么不用 response_format:
 *   - json_object 只保证语法合法，形状不保证（弱一级）
 *   - json_schema 强制最强但 DeepSeek 不支持（实测 400 unavailable）
 *   - function-calling 由服务端约束 arguments 形状，强制力与兼容性平衡最优
 *
 * @param {object} schema - JSON Schema（子图打分/改写的返回形状，单一事实源在 prompts.js）
 * @returns {{ args: object, usage: object|null }}
 * @throws 两轮（原始+自纠）都未通过 schema 校验时抛错，调用方自行兜底
 */
export async function chatStructured(messages, schema, { name = 'submit_result', description = '提交结果', signal } = {}) {
  const tool = { type: 'function', function: { name, description, parameters: schema } }
  let msgs = messages

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await llm.chat.completions.create(
      {
        model: config.llm.model,
        messages: msgs,
        temperature: 0,
        tools: [tool],
        tool_choice: { type: 'function', function: { name } }, // 钉死必须调用该工具
      },
      { signal }
    )
    const msg = res.choices[0]?.message
    const call = msg?.tool_calls?.[0]
    let args = null
    try {
      args = JSON.parse(call?.function?.arguments ?? '')
    } catch { }

    // 服务端强制 ≠ 零失败，客户端 schema 校验兜底
    const invalid =
      args === null || typeof args !== 'object'
        ? '输出不是有效的 JSON 对象'
        : validateSchema(args, schema)
    if (!invalid) return { args, usage: res.usage ?? null }

    if (attempt === 2) throw new Error(`结构化输出未通过 schema 校验: ${invalid}`)
    // 自纠轮：把校验错误以 tool 消息回喂，强制重新提交（与工具参数校验同一回路）
    msgs = [...msgs, msg, { role: 'tool', tool_call_id: call.id, content: `schema 校验失败: ${invalid}，请修正后重新提交` }]
  }
}
