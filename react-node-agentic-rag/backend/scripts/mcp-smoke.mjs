// MCP 客户端冒烟脚本：模拟真实客户端（initialize → tools/list → tools/call）走两种传输
// 用法：node scripts/mcp-smoke.mjs [http|stdio]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2] ?? 'stdio'
const TOKEN = process.env.MCP_HTTP_TOKEN || 'smoke-token'

const transport =
  mode === 'http'
    ? new StreamableHTTPClientTransport(new URL('http://localhost:8790/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      })
    : new StdioClientTransport({
        command: 'node',
        // 按脚本自身位置解析（模拟 IDE 从任意 cwd 拉起的场景）
        args: [fileURLToPath(new URL('../src/mcp/stdio.mjs', import.meta.url))],
      })

const client = new Client({ name: 'mcp-smoke', version: '0.0.1' })
await client.connect(transport)
console.log(`[smoke] connected via ${mode}, server info:`, client.getServerVersion())

const tools = await client.listTools()
console.log('[smoke] tools:', tools.tools.map((t) => t.name).join(', '))

for (const [name, args] of [
  ['rag_stats', {}],
  ['rag_list_docs', { limit: 3 }],
  ['rag_search', { query: 'CNCF 是什么', k: 3 }],
]) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content?.[0]?.text ?? ''
  console.log(`[smoke] ${name} → isError=${!!res.isError}\n${text.slice(0, 220)}${text.length > 220 ? ' …' : ''}\n`)
}

// resources：list + read 第一篇
const rs = await client.listResources()
console.log(`[smoke] resources: ${rs.resources.length} 篇`)
if (rs.resources[0]) {
  const r = await client.readResource({ uri: rs.resources[0].uri })
  console.log(`[smoke] read ${r.contents[0].uri} → ${(r.contents[0].text ?? '').slice(0, 120)} …`)
}

await client.close()
console.log('[smoke] done')
