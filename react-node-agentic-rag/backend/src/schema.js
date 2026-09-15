// 共享迷你 JSON Schema 校验器：只覆盖 required + 基础类型（零依赖）
// 服务端「强制」（tool-call/json_schema）≠ 零失败，这里永远是最后一道防线
export function validateSchema(value, schema, path = '值') {
  const t = schema.type
  if (t) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const ok =
      t === 'string' ? actual === 'string'
        : t === 'number' ? actual === 'number'
          : t === 'boolean' ? actual === 'boolean'
            : t === 'object' ? actual === 'object' && !Array.isArray(value)
              : t === 'array' ? actual === 'array'
                : true
    if (!ok) return `${path} 类型应为 ${t}，实际为 ${actual}`
  }
  for (const k of schema.required ?? []) {
    if (value?.[k] === undefined) return `缺少必填字段 ${path}.${k}`
  }
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    if (value?.[k] !== undefined) {
      const err = validateSchema(value[k], sub, `${path}.${k}`)
      if (err) return err
    }
  }
  return null
}
