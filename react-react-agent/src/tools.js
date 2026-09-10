/** 工具定义：发给 LLM 用它描述自己有哪些工具、怎么调 */
export const tools = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '计算四则算术(含括号)，如 "2+3" "(2+3)*4"',
      parameters: {
        type: 'object',
        properties: { expr: { type: 'string', description: '算术表达式' } },
        required: ['expr'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询某城市的天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，如 北京' } },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_luck',
      description: '根据星座查询今日的运气（真实数据，内容为英文）',
      parameters: {
        type: 'object',
        properties: { constellation: { type: 'string', description: '星座，如 金牛' } },
        required: ['constellation'],
      },
    },
  }
]

/**
 * 工具实现：工具名 → 实际执行的异步函数（Action 分发点）
 * 新增工具 = 在此加一项即可
 */
export const toolImpl = {
  async calculator({ expr }) {
    // 安全求值：正则白名单 + Function 构造器（比 eval 略安全），支持括号
    if (!/^[\d+\-*/ ().]+$/.test(String(expr))) throw new Error('包含非法字符')
    const val = new Function(`"use strict"; return (${expr})`)()
    if (typeof val !== 'number' || !isFinite(val)) throw new Error('结果无效')
    return String(Math.round(val * 100) / 100) // 保留两位
  },
  async get_weather({ city }) {
    // 演示：可换成真实天气 API。这里模拟返回值
    return `${city} 今日晴，26℃，空气质量优`
  },
  async get_luck({ constellation }) {
    // 真实 API：celesian.com（免费无 key，允许跨域）。中文星座 → 英文签名映射
    const map = {
      白羊: 'Aries', 金牛: 'Taurus', 双子: 'Gemini', 巨蟹: 'Cancer',
      狮子: 'Leo', 处女: 'Virgo', 天秤: 'Libra', 天蝎: 'Scorpio',
      射手: 'Sagittarius', 摩羯: 'Capricorn', 水瓶: 'Aquarius', 双鱼: 'Pisces',
    }
    const zh = String(constellation).replace(/座/g, '')
    const en = Object.keys(map).find((k) => zh.includes(k))
    if (!en) throw new Error('不认识的星座，可用：' + Object.keys(map).join('/'))
    const res = await fetch(`https://www.celesian.com/api/widget/horoscope?sign=${map[en]}`)
    if (!res.ok) throw new Error(`运势接口异常 HTTP ${res.status}`)
    const data = await res.json() // { sign, date, horoscope, source }
    return `${constellation} 今日运势(${data.date})：${data.horoscope}`
  },
}
