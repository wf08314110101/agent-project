// ============================================================================
// M19 mock 视觉模型服务（仅测试用）：OpenAI 兼容 /chat/completions 端点。
// OCR 管线发来的图片是 PNG —— mock 解析 IHDR 的宽高作为"内容键"，按映射返回
// 固定转录文本（真实 OCR 的替身，零外部依赖、结果确定性）。
// 映射与 gen-m19-fixtures.mjs 生成的图片尺寸一一对应；未命中返回固定占位文本。
// 运行：node scripts/mock-vlm.mjs   （默认 127.0.0.1:9799）
// 服务端配合：OCR_MODEL=mock-vlm OCR_BASE_URL=http://127.0.0.1:9799/v1
// ============================================================================

import http from 'node:http'

// PNG IHDR：宽在偏移 16、高在偏移 20（大端）
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const TRANSCRIPTS = {
  '1190x1680': `设备巡检操作规程（扫描版）\n\n第五条 机房巡检频次：核心机柜每小时记录一次温度与湿度。\n第六条 UPS 电量低于 30% 触发一级告警，值班人员须在 15 分钟内到场处置。\n第七条 巡检异常须填写工单并同步值班群，夜间联系电话 021-6688。`,
  '1100x620': `服务器采购资产清单\n\n型号：RS720-E9-RS8，数量 3 台，单价 42800 元\n上架机房：浦东 B2-07，验收结论：全部通过`,
  '900x520': `9 月运维值班表（截图）\n\n周一 张伟    周二 李娜    周三 王强\n周四 刘洋    周五 陈静    夜间电话 021-9527`,
}

const PORT = Number(process.env.MOCK_VLM_PORT || 9799)

http
  .createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let text = '（无文字）'
      try {
        const { messages } = JSON.parse(body)
        const img = messages?.[0]?.content?.find((p) => p.type === 'image_url')
        const b64 = img?.image_url?.url?.split(',')[1]
        if (b64) {
          const size = pngSize(Buffer.from(b64, 'base64'))
          text = (size && TRANSCRIPTS[`${size.w}x${size.h}`]) || text
        }
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: {} }))
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[mock-vlm] listening on http://127.0.0.1:${PORT}/v1`))
