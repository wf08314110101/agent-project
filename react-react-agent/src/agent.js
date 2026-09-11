import { callLLMStream, LLM_MODEL } from './llm'
import { tools, toolImpl, networkTools } from './tools'
import { parseArgs, validateArgs } from './utils'
import { lf, langfuseEnabled } from './langfuse'

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

  // 🔗 Langfuse 全链路观测：一次运行 = 一条 Trace（每轮 LLM = Generation，每次工具 = Span）
  const trace = lf.trace({
    name: 'ReAct Agent 运行',
    input: messages,
    metadata: { maxIterations },
  })
  if (langfuseEnabled) onLog(`\n🔗 Langfuse 观测已开启 ｜ trace: ${trace.id}`, 'meta')

  // 结束时统一汇总：用时 + token 消耗（同时写回 Langfuse Trace 收口）
  const finish = (msg, type = 'ok', output = null) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2) // 秒
    trace.update({
      output,
      level: type === 'warn' ? 'WARNING' : 'DEFAULT',
      statusMessage: type === 'warn' ? msg.trim() : undefined,
      metadata: {
        elapsedSec: +elapsed,
        totalTokens,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      },
    })
    onLog(msg, type)
    onLog(`\n⏱️ 总用时 ${elapsed}s ｜ 🧮 Token 消耗: ${totalTokens} (输入 ${totalPromptTokens} + 输出 ${totalCompletionTokens})`, 'meta')
    lf.flushAsync?.().catch?.(() => { }) // 运行一结束就上报，不等 SDK 内部批量周期
  }

  let step = 0
  try {
    while (true) {
      // 【终止条件①】达到最大循环次数 —— 防止无限死循环兜底
      if (step >= maxIterations) {
        finish('⚠️ 达到最大迭代上限，停止', 'warn')
        return
      }
      step++
      onLog(`\n[第 ${step} 轮] `, 'step')

      // ---------- Thought → Action：流式返回，边生成边打印 ----------
      // 🔗 每轮 LLM 调用上报为 Generation：输入=完整上下文，输出=正文+工具调用，usage 来自 include_usage 帧
      const lfGen = trace.generation({
        name: `第 ${step} 轮 LLM 调用`,
        model: LLM_MODEL,
        modelParameters: { temperature: 0 },
        input: messages,
      })
      const assistantMsg = await callLLMStream(messages, {
        signal: o.signal,
        // 正文与工具名都流式逐字打印（工具名前缀+分隔由 llm 端带上）
        onDelta: (text, type) => {
          if (type === 'content' || type === 'tool' || type === 'action') onToken(text, type)
        },
      })
      const u = assistantMsg.usage ?? {}
      lfGen.end({
        output: {
          content: assistantMsg.content,
          tool_calls: (assistantMsg.tool_calls || []).map((tc) => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
        },
        usage: {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
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

          // ---------- 参数校验：按工具声明的 JSON Schema 校验，失败转 Observation 回喂模型自我修正 ----------
          const schema = tools.find((t) => t.function.name === name)?.function.parameters
          const verr = validateArgs(args, schema)
          // 🔗 每次工具执行上报为 Span：输入=参数，输出=Observation，出错标 ERROR 级
          const lfSpan = trace.span({ name: `工具 ${name}`, input: args })
          let obs
          if (verr) {
            obs = `参数校验失败: ${verr}`
            lfSpan.end({ output: obs, level: 'WARNING', statusMessage: verr })
          } else {
            // ---------- 执行工具：网络型工具对瞬时错误有限重试（退避 500ms/1s），attempt 记入 Langfuse ----------
            const maxAttempts = networkTools.has(name) ? 3 : 1 // 首次 + 最多 2 次重试
            let err = null
            let attempts = 0
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              attempts = attempt
              try {
                obs = await toolImpl[name](args)
                lfSpan.end({ output: obs, metadata: { attempt: attempts } })
                err = null
                break
              } catch (e) {
                err = e
                if (!(attempt < maxAttempts && isRetryable(e))) break
                onLog(`⚠️ 第 ${attempt} 次调用失败（${e.message}），${500 * attempt}ms 后重试`, 'warn')
                await new Promise((r) => setTimeout(r, 500 * attempt)) // 指数退避
              }
            }
            if (err) {
              obs = `工具出错: ${err.message}`
              lfSpan.end({ output: obs, level: 'ERROR', statusMessage: err.message, metadata: { attempts } })
            }
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
        finish('\n✅ 任务完成', 'ok', answer)
        return
      }
      if (step >= maxIterations) {
        finish('⚠️ 空输出，停止', 'warn')
        return
      }
    }
  } catch (e) {
    // 🔗 手动停止 / API 出错也收口 Trace，Langfuse 里能看到中断的运行
    trace.update({
      output: null,
      level: e.name === 'AbortError' ? 'WARNING' : 'ERROR',
      statusMessage: e.message,
    })
    throw e
  }
}

/** 把一次性文本逐字推给 onToken，每字间隔制造流式节奏（工具返回不是流的，用此法模拟） */
async function typeOut(text, onToken, ms = 15) {
  for (const ch of Array.from(String(text))) {
    onToken(ch, 'obs')
    await new Promise((r) => setTimeout(r, ms))
  }
}

/** 是否值得重试：仅瞬时网络错误（fetch 连接失败 / HTTP 5xx / 429）；参数与业务类错误重试无意义 */
function isRetryable(e) {
  return e?.name === 'TypeError' || /HTTP (5\d\d|429)/.test(e?.message ?? '')
}
