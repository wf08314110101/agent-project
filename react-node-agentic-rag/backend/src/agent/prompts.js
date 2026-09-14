// Agent 提示词：主图系统提示 + 子图评估/改写
export const AGENT_SYSTEM = `你是一个严谨的知识库问答助手，可以调用工具。
规则：
1. 涉及知识库内容的问题，调用 search_knowledge 检索；若结果不足，可换一种问法再检索
2. 数学计算用 calculator；需要当前时间用 get_current_time
3. 回答优先依据检索到的资料；若资料中没有，先说明「知识库中未找到」，再基于通用知识补充回答，补充部分必须注明「（以下为通用知识）」
4. 用简体中文回答，关键结论后标注来源编号，如 [1]`

export const FORCE_ANSWER = '已达最大工具调用轮数，请立即基于已获得的资料直接回答，不要再调用任何工具。'

// 相关性评估：逐条判断 + 是否足以回答
export const gradeMessages = (question, hits) => {
  const numbered = hits
    .map((h, i) => `[${i + 1}] ${h.title || h.filename || '无标题'}\n${h.text}`)
    .join('\n\n')
  return [
    { role: 'system', content: '你是检索结果相关性评估器，只输出 JSON，不要输出其他内容。' },
    {
      role: 'user',
      content: `问题: ${question}

候选资料:
${numbered || '（无）'}

逐条判断资料是否与问题相关，输出 JSON:
{"relevant": ["相关的资料编号，如 "1","3""], "enough": 布尔值(相关资料是否足以回答问题), "reason": "材料不足时一句话说明缺什么，充足则为空字符串"}`,
    },
  ]
}

// 查询改写：换角度提升召回
export const rewriteMessages = (question, prevQueries, feedback) => [
  { role: 'system', content: '你是检索查询改写器，只输出 JSON，不要输出其他内容。' },
  {
    role: 'user',
    content: `原始问题: ${question}
已尝试的查询: ${prevQueries.join(' | ')}
上一轮不足: ${feedback || '召回不相关或数量不足'}

请给出 2 个不同的检索改写（同义词替换/上位概念/换个问法），避免与已尝试的重复。
输出 JSON: {"queries": ["改写1", "改写2"]}`,
  },
]
