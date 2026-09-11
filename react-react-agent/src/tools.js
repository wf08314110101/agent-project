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
    // 真实 API：Open-Meteo（免费无 key，允许跨域）。城市名 → 经纬度 → 当前天气
    const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`)
    if (!geo.ok) throw new Error(`城市解析接口异常 HTTP ${geo.status}`)
    const loc = (await geo.json()).results?.[0]
    if (!loc) throw new Error(`找不到城市：${city}`)
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`)
    if (!res.ok) throw new Error(`天气接口异常 HTTP ${res.status}`)
    const w = (await res.json()).current
    // WMO 天气代码 → 中文描述
    const codes = { 0: '晴', 1: '基本晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '大阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹' }
    return `${loc.name}（${loc.country ?? ''}）当前 ${codes[w.weather_code] ?? '天气未知'} ${w.temperature_2m}℃ ｜ 湿度 ${w.relative_humidity_2m}% ｜ 风速 ${w.wind_speed_10m} km/h`
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

/** 网络型工具：瞬时错误（连接失败 / HTTP 5xx / 429）允许 agent 层有限重试 */
export const networkTools = new Set(['get_weather', 'get_luck'])
