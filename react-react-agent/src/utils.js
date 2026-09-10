/** 解析 tools.arguments JSON 字符串，出错时记录日志并返回空对象 */
export function parseArgs(argsStr, onLog) {
  try {
    return JSON.parse(argsStr ?? '{}')
  } catch (e) {
    onLog?.('⚠️ 参数解析失败: ' + e.message)
    return {}
  }
}