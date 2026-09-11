import { callLLMStream } from './llm'
import { tools, toolImpl } from './tools'
import { parseArgs } from './utils'

/**
 * ReAct while 主循环（真实流式版）
 * 多轮对话：messages 是「会话级」共享数组（跨多次调用累积），
 *           每一轮的 assistant/tool/Observation 都会 push 进来，
 *           下一轮问题直接在此基础上继续，天然带上历史上下文。
 * @param messages 共享上下文数组（调用方需先 push 当前用户消息）
 * @param onLog (text, type) 一次性日志（换行、分隔、错误提示等）
 * @param o.onToken (ch, type) 逐 token 回调：LLM 的 token 与工具输出都走这里，实现真流式
 * @param o.maxIterations 最大循环次数（防无限死循环）
 * @param o.signal 用于手动停止
 */
export async function agent(messages, onLog, o = {}) {
  const maxIterations = o.maxIterations ?? 6
  const onToken = o.onToken ?? (() => { })

  const startedAt = Date.now() // ⏱ 任务总用时起点
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalTokens = 0

  // 结束时统一汇总：用时 + token 消耗
  const finish = (msg, type = 'ok') => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2) // 秒
    onLog(msg, type)
    onLog(`\n⏱️ 总用时 ${elapsed}s ｜ 🧮 Token 消耗: ${totalTokens} (输入 ${totalPromptTokens} + 输出 ${totalCompletionTokens})`, 'meta')
  }

  let step = 0
  while (true) {
    // 【终止条件①】达到最大循环次数 —— 防止无限死循环兜底
    if (step >= maxIterations) {
      finish('⚠️ 达到最大迭代上限，停止', 'warn')
      return
    }
    step++
    onLog(`\n[第 ${step} 轮] `, 'step')

    // ---------- Thought → Action：流式返回，边生成边打印 ----------
    console.log('agent-43行 2026-09-10', messages)
    const assistantMsg = await callLLMStream(messages, {
      signal: o.signal,
      // 正文与工具名都流式逐字打印（工具名前缀+分隔由 llm 端带上）
      onDelta: (text, type) => {
        if (type === 'content' || type === 'tool' || type === 'action') onToken(text, type)
      },
    })
    messages.push(assistantMsg)

    // 累加本轮 token 消耗
    if (assistantMsg.usage) {
      totalPromptTokens += assistantMsg.usage.prompt_tokens || 0
      totalCompletionTokens += assistantMsg.usage.completion_tokens || 0
      totalTokens += assistantMsg.usage.total_tokens || 0
    }

    const toolCalls = assistantMsg.tool_calls || []
    if (toolCalls.length) {
      // ---------- Action + Action Input ----------
      for (const tc of toolCalls) {
        const { name, arguments: argsStr } = tc.function
        const args = parseArgs(argsStr, onLog)
        // 工具名已由 llm 流式打出，这里补打完整参数 JSON
        onLog(`${argsStr}\n`, 'action')

        // ---------- 执行工具，Observation 也逐字流式打出（制造节奏） ----------
        let obs
        try {
          obs = await toolImpl[name](args)
        } catch (e) {
          obs = `工具出错: ${e.message}`
        }
        onLog('\n   Observation: ', 'obs')
        await typeOut(String(obs), onToken) // 逐字推送 Observation

        // Observation → 回填上下文（需配对 tool_call_id），供下一轮思考
        messages.push({ role: 'tool', tool_call_id: tc.id, content: obs })
      }
      continue // 💡 回到 while，模型基于 Observation 继续
    }

    // 【终止条件②】无工具调用且返回正文 → 正常结束（正文已流式打完了）
    const answer = (assistantMsg.content || '').trim()
    if (answer) {
      finish('\n✅ 任务完成')
      return
    }
    if (step >= maxIterations) {
      finish('⚠️ 空输出，停止', 'warn')
      return
    }
  }
}

/** 把一次性文本逐字推给 onToken，每字间隔制造流式节奏（工具返回不是流的，用此法模拟） */
async function typeOut(text, onToken, ms = 15) {
  for (const ch of Array.from(String(text))) {
    onToken(ch, 'obs')
    await new Promise((r) => setTimeout(r, ms))
  }
}