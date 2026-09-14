// 主图：ReAct agent loop（LangGraph 状态图）
// agent(流式 LLM+工具绑定) → 有 tool_calls ? tools(执行+回填) : END；tools → 回 agent
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { chatStream } from '../llm.js'
import { config } from '../config.js'
import { toolDefs, runTool } from './tools.js'
import { FORCE_ANSWER } from './prompts.js'
import { otelSpan } from '../obs/phoenix.js'

const AgentState = Annotation.Root({
  messages: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
  stepCount: Annotation({ reducer: (_, y) => y, default: () => 0 }),
  stopReason: Annotation({ reducer: (_, y) => y, default: () => null }),
})

// Thought 阶段：流式调 LLM（正文 token 直接走 delta 事件）
async function agentNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const stepCount = state.stepCount + 1
  const force = stepCount > config.agent.maxIterations
  const messages = force ? [...state.messages, { role: 'system', content: FORCE_ANSWER }] : state.messages

  const lfGen = c.trace?.generation?.({
    name: `第 ${stepCount} 轮`,
    model: config.llm.model,
    input: messages,
  })
  const span = otelSpan(`agent.round-${stepCount}`, 'LLM', {
    'llm.model_name': config.llm.model,
    'input.value': JSON.stringify(messages).slice(0, 2000),
  })

  const { message, usage } = await chatStream(messages, {
    tools: force ? undefined : toolDefs,
    toolChoice: force ? 'none' : undefined, // 超轮数：强制直接作答
    signal: c.signal,
    onDelta: (text) => c.emit?.('delta', { text }),
  })

  c.usageAcc?.push(usage)
  lfGen?.end?.({
    output: message,
    usage: usage && {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
  })
  span.end(message.content)

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

// Action + Observation：执行工具，结果以 role:tool 回填上下文
async function toolsNode(state, cfg) {
  const c = cfg?.configurable ?? {}
  const last = state.messages[state.messages.length - 1]
  const newMsgs = []

  for (const tc of last.tool_calls) {
    let args = {}
    try {
      args = JSON.parse(tc.function.arguments || '{}')
    } catch {}
    c.emit?.('step', { phase: 'action', label: tc.function.name, content: tc.function.arguments })

    const lfSpan = c.trace?.span?.({ name: `工具 ${tc.function.name}`, input: args })
    const span = otelSpan(`tool.${tc.function.name}`, 'TOOL', { 'input.value': tc.function.arguments })

    let obs
    try {
      obs = await runTool(tc.function.name, args, cfg)
      lfSpan?.end?.({ output: String(obs).slice(0, 500) })
      span.end(String(obs).slice(0, 800))
    } catch (e) {
      obs = `工具出错: ${e.message}`
      lfSpan?.end?.({ output: obs, level: 'ERROR', statusMessage: e.message })
      span.end(obs)
    }

    c.emit?.('step', {
      phase: 'observation',
      label: tc.function.name,
      content: String(obs).length > 200 ? String(obs).slice(0, 200) + '…' : String(obs),
    })
    newMsgs.push({ role: 'tool', tool_call_id: tc.id, content: obs })
  }
  return { messages: newMsgs }
}

export const agentGraph = new StateGraph(AgentState)
  .addNode('agent', agentNode)
  .addNode('tools', toolsNode)
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', route)
  .addEdge('tools', 'agent')
  .compile()

// 供路由调用的门面：emitter/trace/signal/topK 经 configurable 贯穿主图与子图
export function runAgent({ messages, topK = 5, signal, emit, trace, usageAcc }) {
  return agentGraph.invoke(
    { messages, stepCount: 0 },
    {
      configurable: {
        emit,
        signal,
        trace,
        usageAcc,
        topK,
      },
    }
  )
}
