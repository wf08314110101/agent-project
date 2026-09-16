// ============================================================================
// 工具定义 + 实现：search_knowledge（走 CRAG 子图）/ calculator / get_current_time
// ----------------------------------------------------------------------------
// toolDefs  : 提供给 LLM 的工具 JSON Schema（function calling 规范）
// runTool   : Action 分发点，按工具名执行并返回 Observation 字符串
// 设计原则：工具出错不抛异常，而是把错误文本作为 Observation 回喂模型自我修正。
// ============================================================================

import { searchGraph } from './search-graph.js'
import { validateSchema } from '../schema.js'

// 工具的 JSON Schema 描述：LLM 依据 description 和 parameters 决定何时调用、怎么传参
export const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        '在用户上传的知识库中检索相关资料。涉及文档内容、事实、概念的问题应调用；结果不足时可换不同问法多次调用。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要检索的问题，完整的自然语言问句' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '计算数学表达式，支持 + - * / ( ) %。',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: '如 (1+2)*3/4' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前系统时间。',
      parameters: { type: 'object', properties: {} },
    },
  },
]

// 白名单正则：只允许数字与四则运算符/括号/百分号/空白，杜绝任意代码注入
const SAFE_EXPR = /^[0-9+\-*/().%\s]+$/

function calc(expr) {
  if (!SAFE_EXPR.test(expr)) return '表达式包含非法字符'
  try {
    // 通过 Function 构造器求值（比 eval 稍安全，且已被白名单限制输入）
    return `${expr} = ${Function('"use strict";return (' + expr + ')')()}`
  } catch {
    return '表达式无法计算'
  }
}

// 工具执行前的参数校验入口；未知工具返回 null（由 runTool 兜底提示可用工具）
export function validateToolArgs(name, args) {
  const def = toolDefs.find((d) => d.function.name === name)
  if (!def) return null
  return validateSchema(args, def.function.parameters ?? {})
}

/**
 * Action 分发点：返回 Observation 字符串（出错也转 Observation 回喂模型自我修正）
 * @param {string} name - 工具名（可能来自模型幻觉，需兜底处理）
 * @param {object} args - 工具参数（主图已 JSON.parse）
 * @param {object} cfg  - LangGraph cfg，configurable 内含 emit/signal/topK/usageAcc
 */
export async function runTool(name, args, cfg) {
  switch (name) {
    case 'search_knowledge': {
      // 子图：初始 queries=[question]，attempts=1；configurable（emit/trace/signal/topK）透传到子图节点
      const res = await searchGraph.invoke(
        { question: String(args.question ?? ''), queries: [String(args.question ?? '')], attempts: 1 },
        cfg
      )
      // 全局引用编号：跨多轮 search_knowledge 连续编号（同块不重复编号），
      // 保证 Observation 里的 [n] 与前端 sources 卡片位置一一对应，行内引用可点击跳转
      const cc = cfg?.configurable ?? {}
      cc.citeMap ??= new Map() // key = docId:chunkIndex → 全局编号；每次 invoke 独立
      for (const h of res.hits) {
        const k = `${h.docId}:${h.chunkIndex}`
        if (!cc.citeMap.has(k)) cc.citeMap.set(k, cc.citeMap.size + 1)
        h.cite = cc.citeMap.get(k) // 随 sources 事件下发，前端渲染编号徽标
      }
      // sources 事件：把最终命中资料推给前端做引用展示
      cfg?.configurable?.emit?.('sources', { sources: res.hits })
      if (!res.hits.length) return `知识库中没有找到与「${args.question}」相关的资料。`
      // 把命中块拼成带全局编号+相似度的资料文本，编号即回答中 [n] 的取值来源
      const body = res.hits
        .map(
          (h, i) =>
            `[${h.cite}] (相似度 ${h.score.toFixed(3)}) ${h.filename}${h.title ? ' · ' + h.title : ''}\n${h.text}`
        )
        .join('\n\n')
      return `检索到 ${res.hits.length} 条资料（材料${res.enough ? '充足' : '有限'}；引用编号 [n] 为全局唯一，回答中原样使用）:\n\n${body}`
    }
    case 'calculator':
      return calc(String(args.expression ?? ''))
    case 'get_current_time':
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    default:
      // 模型幻觉工具名 → 友好提示可用工具，引导自我修正
      return `未知工具 ${name}，可用工具: search_knowledge / calculator / get_current_time`
  }
}
