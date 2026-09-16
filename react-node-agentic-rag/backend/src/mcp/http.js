// ============================================================================
// MCP Streamable HTTP 挂载：POST /mcp（Bearer 鉴权），给远程/多客户端场景
// ----------------------------------------------------------------------------
// 无状态模式：每请求新建 Server+Transport（连接都是模块级单例，开销可忽略），
// 不做会话管理 → 多实例（M12）天然兼容，任意实例可服务。
// 鉴权：Authorization: Bearer <MCP_HTTP_TOKEN>；未配置 token 则不挂载（见 server.js）。
// ============================================================================

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildMcpServer } from './mcp-server.js'
import { config } from '../config.js'

export default async function mcpHttpPlugin(app) {
  app.post('/mcp', async (req, reply) => {
    // Bearer 校验（时序安全比较）
    const auth = req.headers.authorization ?? ''
    const ok =
      auth.startsWith('Bearer ') &&
      auth.length === `Bearer ${config.mcp.httpToken}`.length &&
      auth.slice(7) === config.mcp.httpToken
    if (!ok) return reply.code(401).send({ error: '未授权：需要 Bearer MCP_HTTP_TOKEN' })

    const server = buildMcpServer({ log: app.log })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态
      enableJsonResponse: true,      // 纯 JSON 响应（不开 SSE 流）
    })
    // 响应结束后释放本请求的 server/transport
    reply.raw.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    try {
      await server.connect(transport)
      // 传输层直接写 reply.raw（状态码/响应体由协议层控制）
      await transport.handleRequest(req.raw, reply.raw, req.body)
      return reply.hijack() // 已由传输层接管响应，阻止 Fastify 重复发送
    } catch (e) {
      app.log.error(`[mcp] 请求处理失败: ${e.message}`)
      if (!reply.raw.headersSent) return reply.code(400).send({ jsonrpc: '2.0', error: { code: -32700, message: '解析错误' }, id: null })
      return reply.hijack()
    }
  })

  // 无状态模式不支持 GET（SSE 流）与 DELETE（会话终止）
  const deny = (_req, reply) => reply.code(405).header('Allow', 'POST').send()
  app.get('/mcp', deny)
  app.delete('/mcp', deny)
}
