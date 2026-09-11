// 预算管理：分层预算 + 预估/记账 + 检查点止损
export const BUDGET = {
  perReplyTokens: 2048, // 单次输出上限(与 llm.maxTokens 联动)
  perTurnTokens: 12000, // 单轮输入+输出软限
  totalTokens: 60000,   // 会话总预算(硬止损)
  degradeAt: 0.8,       // 用量占比达该值触发降级
}

// 粗略估算 token：中文≈1字/token，英文≈4字符/token，取 1.3 折中
export const estTokens = (t) => Math.ceil(String(t ?? '').length / 1.3)

export const estMessages = (msgs) =>
  msgs.reduce(
    (n, m) => n + estTokens(m.content) + estTokens(m.tool_calls?.[0]?.function?.arguments),
    0
  )

export function createBudget(o = {}) {
  const cfg = { ...BUDGET, ...o }
  let used = 0 // 真实累计消耗(以 API 返回 usage 为准)

  // 前置检查：返回 ok / degrade / stop，est 为预估本轮消耗
  const check = (msgs) => {
    const est = used + estMessages(msgs)
    if (est > cfg.totalTokens)
      return { status: 'stop', reason: `预计超总预算 ${est}/${cfg.totalTokens}` }
    if (est > cfg.perTurnTokens)
      return { status: 'degrade', act: 'trim', reason: `本轮预估 ${est} 超单轮软限 ${cfg.perTurnTokens}` }
    if (used / cfg.totalTokens >= cfg.degradeAt)
      return { status: 'degrade', act: 'summarize', reason: `已用 ${used}(${((used / cfg.totalTokens) * 100) | 0}%)，接近预算` }
    return { status: 'ok' }
  }

  const spend = (usage) => { used += usage?.total_tokens ?? 0 }
  return { get used() { return used }, check, spend }
}
