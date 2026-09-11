/** 解析 tools.arguments JSON 字符串，出错时记录日志并返回空对象 */
export function parseArgs(argsStr, onLog) {
  try {
    return JSON.parse(argsStr ?? '{}')
  } catch (e) {
    onLog?.('⚠️ 参数解析失败: ' + e.message)
    return {}
  }
}

/** 按 JSON Schema 轻量校验参数（必填 + 基础类型），返回错误文本，通过返回 null */
export function validateArgs(args, schema) {
  if (!schema) return null
  const missing = (schema.required || []).filter((k) => args?.[k] == null || args?.[k] === '')
  if (missing.length) return `缺少必填参数 ${missing.join('、')}`
  for (const [key, p] of Object.entries(schema.properties || {})) {
    const v = args?.[key]
    if (v == null) continue
    const ok = p.type === 'array' ? Array.isArray(v) : typeof v === p.type
    if (!ok) return `参数 ${key} 应为 ${p.type}`
  }
  return null
}