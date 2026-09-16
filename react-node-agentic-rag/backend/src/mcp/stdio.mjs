// ============================================================================
// MCP stdio 入口：由 MCP 客户端（Cursor/Claude Code/Trae/Inspector）以子进程拉起
// ----------------------------------------------------------------------------
// 协议走 stdin/stdout JSON-RPC；依赖模块（embedder/qdrant）的 console.log
// 全部重定向到 stderr，避免污染 stdout 协议通道。
// .env 按本文件位置解析（客户端拉起时的 cwd 不确定，dotenv 默认读 process.cwd()）。
// 启动：npm run mcp:stdio
// ============================================================================

console.log = (...a) => console.error(...a) // stdout 仅承载协议

import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
// 显式加载 backend/.env（import.meta.url 含中文路径，必须 fileURLToPath 还原）
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true })

import { buildMcpServer } from './mcp-server.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = buildMcpServer({ log: console })
await server.connect(new StdioServerTransport())
console.error('[mcp] agentic-rag-kb stdio 已启动（tools: rag_search/rag_list_docs/rag_doc_status/rag_stats）')

// 客户端断开（关闭 stdin）时 SDK 会自动结束进程，无需额外处理
