// 工具定义 + 实现：search_knowledge(子图) / calculator / get_current_time
import { searchGraph } from './search-graph.js'

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

const SAFE_EXPR = /^[0-9+\-*/().%\s]+$/
function calc(expr) {
  if (!SAFE_EXPR.test(expr)) return '表达式包含非法字符'
  try {
    return `${expr} = ${Function('"use strict";return (' + expr + ')')()}`
  } catch {
    return '表达式无法计算'
  }
}

// Action 分发点：返回 Observation 字符串（出错也转 Observation 回喂模型自我修正）
export async function runTool(name, args, cfg) {
  switch (name) {
    case 'search_knowledge': {
      // 子图：初始 queries=[question]，attempts=1；configurable（emit/trace/signal/topK）透传到子图节点
      const res = await searchGraph.invoke(
        { question: String(args.question ?? ''), queries: [String(args.question ?? '')], attempts: 1 },
        cfg
      )
      cfg?.configurable?.emit?.('sources', { sources: res.hits })
      if (!res.hits.length) return `知识库中没有找到与「${args.question}」相关的资料。`
      const body = res.hits
        .map(
          (h, i) =>
            `[${i + 1}] (相似度 ${h.score.toFixed(3)}) ${h.filename}${h.title ? ' · ' + h.title : ''}\n${h.text}`
        )
        .join('\n\n')
      return `检索到 ${res.hits.length} 条资料（材料${res.enough ? '充足' : '有限'}）:\n\n${body}`
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
