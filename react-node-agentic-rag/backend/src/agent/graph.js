// ============================================================================
// 主图：ReAct agent loop（LangGraph 状态图）
// ----------------------------------------------------------------------------
// 拓扑：
//   START → agent →（有 tool_calls 且未超轮数）→ tools → agent → ...
//                →（无 tool_calls 或超轮数）→ END
// 每轮对应 ReAct 的一次循环：
//   agent 节点 = Thought（流式调 LLM，正文 token 通过 emit('delta') 转发前端）
//   tools 节点 = Action（发起工具调用）+ Observation（结果以 role:tool 回填上下文）
// ============================================================================

import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { chatStream } from '../llm.js'
import { config } from '../config.js'
import { toolDefs, runTool, validateToolArgs } from './tools.js'
import { FORCE_ANSWER, AGENT_SYSTEM } from './prompts.js'
import { leaksSystemPrompt } from './injection.js'
import { otelSpan } from '../obs/otel.js'

// 状态定义：Annotation 描述每个字段的合并策略（reducer）
const AgentState = Annotation.Root({
  // messages 采用 concat 合并：节点返回的消息数组会追加到已有历史之后
  messages: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
  // stepCount 直接覆盖：记录当前是第几轮（用于超轮数强制直答）
  stepCount: Annotation({ reducer: (_, y) => y, default: () => 0 }),
  // stopReason 直接覆盖：结束原因（max_iter=超轮数 / 正常结束保持 null）
  stopReason: Annotation({ reducer: (_, y) => y, default: () => null }),
})

// Thought 阶段：流式调 LLM（正文 token 直接走 delta 事件）
async function agentNode(state, cfg) {
  // configurable 是 LangGraph 传递运行时上下文的通道（贯穿主图与子图）
  const c = cfg?.configurable ?? {}
  const stepCount = state.stepCount + 1

  // 超过最大轮数 → 注入 FORCE_ANSWER 系统提示并禁用工具，逼模型立即作答（防死循环）
  const force = stepCount > config.agent.maxIterations
  const messages = force ? [...state.messages, { role: 'system', content: FORCE_ANSWER }] : state.messages

  // ---- 观测埋点：单一 OTel 管道（Phoenix/Langfuse 双导出）----
  const span = otelSpan(`agent.round-${stepCount}`, 'LLM', {
    'llm.model_name': config.llm.model,
    'input.value': JSON.stringify(messages).slice(0, 2000), // 截断防止 span 过大
  })

  // 流式调用：正文 token 走 delta 事件（打字机效果），思维链 token 走独立 reasoning 事件
  const { message, usage } = await chatStream(messages, {
    tools: force ? undefined : toolDefs,
    toolChoice: force ? 'none' : undefined, // 超轮数：强制直接作答
    signal: c.signal,
    onDelta: (text) => c.emit?.('delta', { text }),
    onReason: (text) => c.emit?.('reasoning', { text }),
  })

  // 输出侧防注入：回答套取/复述系统提示 → 替换为拒答（span 记 WARNING，不影响 tool_calls 流程）
  let leakBlocked = false
  if (message.content && leaksSystemPrompt(message.content, AGENT_SYSTEM)) {
    message.content = '抱歉，我无法回答该问题。'
    leakBlocked = true
  }

  // 累计每轮 usage，路由层最后统一汇总；span 记录输出与 token 用量
  c.usageAcc?.push(usage)
  span.end(message.content, leakBlocked ? { level: 'WARNING', statusMessage: '回答疑似泄露系统提示，已替换为拒答' } : { usage })

  // 返回新状态：追加 assistant 消息 + 更新轮数；force 时标记 stopReason
  return { messages: [message], stepCount, stopReason: force ? 'max_iter' : state.stopReason }
}

// 路由：有工具调用且未超轮数 → tools；否则结束
function route(state) {
  const last = state.messages[state.messages.length - 1]
  if (last?.role === 'assistant' && last.tool_calls?.length && state.stepCount <= config.agent.maxIterations) {
    return 'tools'
  }
  return END
}

// 重复 Action 检测：同参同工具的调用结果必然一致，复用缓存 Observation，
// 不再执行工具（检索/LLM 调用都省掉），并注入提示引导模型换问法或直接作答。
// key 需要键序稳定：JSON.stringify 的递归 sort 保证 {a,b} 与 {b,a} 生成同一 key
const stableKey = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort())
      : x
  )

// Action + Observation：执行工具，结果以 role:tool 回填上下文
// 同批 tool_calls 并发执行（Promise.all）：单工具场景零变化，多工具时延迟 ≈ 最慢一个
// 复用提示：跨轮（actionLog 命中）或同批（inflight 命中）的重复调用都直接复用结果并附自纠提示
const REUSE_HINT = '\n\n（系统提示：该调用此前已执行且参数完全相同，结果不会变化。请勿重复调用——请基于已有结果继续回答，或换一种问法/工具。）'

async function toolsNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const last = state.messages[state.messages.length - 1]
  // 同批内 cacheKey → 执行 Promise：相同调用只执行一次，重复者 await 同一结果
  const inflight = new Map()

  /** 实际执行单个工具（含 span/usage/缓存），异常已内化为 Observation 字符串，永不 reject */
  const execOne = async (tc, args, cacheKey) => {
    const span = otelSpan(`tool.${tc.function.name}`, 'TOOL', { 'input.value': tc.function.arguments })
    let obs
    try {
      obs = await runTool(tc.function.name, args, cfg)
      span.end(String(obs).slice(0, 800))
    } catch (e) {
      obs = `工具出错: ${e.message}`
      span.end(obs, { level: 'ERROR', statusMessage: e.message })
    }
    // 成功/失败都入缓存：同参重试注定同结果，失败应换问法而非原样重试
    c.actionLog?.set(cacheKey, obs)
    // Observation 事件：截断展示给前端（完整内容仍在上下文里）
    c.emit?.('step', {
      phase: 'observation',
      label: tc.function.name,
      content: String(obs).length > 200 ? String(obs).slice(0, 200) + '…' : String(obs),
    })
    return obs
  }

  // 并发执行每个 tool_call；结果按 tool_calls 原下标回填（完成顺序不影响消息顺序）
  const results = await Promise.all(
    last.tool_calls.map(async (tc) => {
      // 解析工具参数：模型输出的 arguments 是 JSON 字符串，解析失败按空参数处理
      let args = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch { }

      // LLM 输出不可信：参数先过 schema 校验，失败以 Observation 回喂自纠，不执行
      const invalid = validateToolArgs(tc.function.name, args)
      if (invalid) {
        const obs = `参数校验失败: ${invalid}。请按工具定义修正参数后重试。`
        c.emit?.('step', { phase: 'observation', label: tc.function.name, content: obs })
        return obs
      }

      // Action 事件：告知前端模型决定调用什么工具
      c.emit?.('step', { phase: 'action', label: tc.function.name, content: tc.function.arguments })

      // 重复 Action 检测（跨轮）：完全相同的调用直接复用上次结果
      const cacheKey = `${tc.function.name}:${stableKey(args)}`
      if (c.actionLog?.has(cacheKey)) {
        c.emit?.('step', {
          phase: 'observation',
          label: tc.function.name,
          content: '检测到重复 Action，复用上次结果（未重新执行）',
        })
        return c.actionLog.get(cacheKey) + REUSE_HINT
      }

      // 同批去重：相同调用共享同一个执行 Promise，先到先执行、后到复用
      if (inflight.has(cacheKey)) {
        const obs = await inflight.get(cacheKey)
        c.emit?.('step', {
          phase: 'observation',
          label: tc.function.name,
          content: '检测到重复 Action，复用本次批次结果（未重复执行）',
        })
        return obs + REUSE_HINT
      }
      const p = execOne(tc, args, cacheKey)
      inflight.set(cacheKey, p)
      return p
    })
  )

  // OpenAI 规范：工具结果必须以 role:'tool' + tool_call_id 回填（与 tool_calls 一一对应）
  return {
    messages: last.tool_calls.map((tc, i) => ({ role: 'tool', tool_call_id: tc.id, content: results[i] })),
  }
}

// ---- 编译状态图：节点 + 边（条件边由 route 决定走向）----
export const agentGraph = new StateGraph(AgentState)
  .addNode('agent', agentNode)
  .addNode('tools', toolsNode)
  .addEdge(START, 'agent')              // 入口
  .addConditionalEdges('agent', route)  // agent 后按 route 条件跳转
  .addEdge('tools', 'agent')            // 工具执行完回到 agent（ReAct 循环）
  .compile()

/**
 * 供路由调用的门面：emitter/signal/topK/usageAcc 经 configurable 贯穿主图与子图
 * @param {Array}  messages - 初始消息（system + 历史 + 当前 user 问题）
 * @param {number} topK     - 检索条数，透传给 search_kb 子图
 * @param {AbortSignal} signal - 客户端断开时中断 LLM 请求
 * @param {Function} emit   - SSE 事件发射器 (event, data)
 * @param {Array}  usageAcc- usage 累积数组，路由层最后汇总
 * @param {string} [docId] - 指定文档检索范围（「对此文档提问」），空则检索全库
 * @param {object|null} [acl] - M10 RBAC 检索过滤（aclFor 产物），贯穿到 search_kb 子图
 */
export function runAgent({ messages, topK = 5, signal, emit, usageAcc, docId, acl }) {
  return agentGraph.invoke(
    { messages, stepCount: 0 },
    {
      configurable: {
        emit,
        signal,
        usageAcc,
        topK,
        docId: docId || undefined, // 贯穿到 search_kb 子图的 retrieveNode（payload 过滤）
        acl: acl ?? undefined,    // 贯穿到 retrieveNode：密级/归属/授权的服务端过滤
        actionLog: new Map(), // 重复 Action 检测缓存（每次 invoke 独立，跨请求不共享）
      },
    }
  )
}
