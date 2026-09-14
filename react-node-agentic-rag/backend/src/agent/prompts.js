// ============================================================================
// Agent 提示词集中管理：主图系统提示 + 子图评估/改写模板
// ----------------------------------------------------------------------------
// 好处：所有提示词一处维护，方便调优与对照实验。
// 注意：评估/改写模板要求模型"只输出 JSON"，配合 llm.js 的 json_object 模式。
// ============================================================================

// 主图系统提示：定义 Agent 的角色、工具使用规则与引用规范
export const AGENT_SYSTEM = `你是一个严谨的知识库问答助手，可以调用工具。
规则：
1. 涉及知识库内容的问题，调用 search_knowledge 检索；若结果不足，可换一种问法再检索
2. 数学计算用 calculator；需要当前时间用 get_current_time
3. 回答优先依据检索到的资料；若资料中没有，先说明「知识库中未找到」，再基于通用知识补充回答，补充部分必须注明「（以下为通用知识）」
4. 用简体中文回答，关键结论后标注来源编号，如 [1]`

// 超轮数兜底提示：强制模型停止调用工具，基于已有信息立即作答（防死循环）
export const FORCE_ANSWER = '已达最大工具调用轮数，请立即基于已获得的资料直接回答，不要再调用任何工具。'

/**
 * 相关性评估消息模板（grade 节点用）
 * 要求模型逐条判断资料与问题的相关性，并给出"是否足够回答"的结论与不足原因。
 * @param {string} question - 用户问题
 * @param {Array}  hits     - 检索命中块（title/text），自动编号为 [1][2]...
 * @returns {Array} OpenAI 消息数组，期望输出 {"relevant": [...], "enough": bool, "reason": str}
 */
export const gradeMessages = (question, hits) => {
  // 将命中块编号拼接：编号与最终回答里的 [1] 引用一一对应
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

/**
 * 查询改写消息模板（rewrite 节点用）
 * 提供原问题 + 已尝试查询（避免重复）+ 不足原因（对症下药），让模型换角度改写以提升召回。
 * @param {string} question    - 原始问题
 * @param {Array}  prevQueries - 已尝试过的查询词列表
 * @param {string} feedback    - 上一轮评估的不足说明（缺什么）
 * @returns {Array} OpenAI 消息数组，期望输出 {"queries": ["改写1", "改写2"]}
 */
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
