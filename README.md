

# Agent Project

这是一个包含多个 AI Agent 相关子项目的仓库，涵盖了 LLM 流式通信、Agentic RAG（检索增强生成）和 ReAct Agent 等核心场景。每个子项目都是独立可运行的完整应用，你可以根据需求选择相应的技术栈进行学习和使用。

## 项目结构

| 子项目 | 描述 | 技术栈 | 核心功能 |
|--------|------|--------|----------|
| [LLM-SSE](LLM-SSE/README.md) | LLM 流式输出完整解决方案 | Node.js | 多厂商 API 兼容、SSE 协议封装、浏览器/CLI 示例 |
| [react-node-agentic-rag](react-node-agentic-rag/README.md) | React + Node.js Agentic RAG | React + Node.js + LangGraph | Graph-based Agent（ReAct 循环）、混合检索（稠密+稀疏 RRF）、RBAC 密级权限、MCP Server、全链路可观测 |
| [react-python-rag](react-python-rag/README.md) | Python RAG 后端实现 | FastAPI + Python | PDF/Word OCR、向量检索、流式生成 |
| [react-react-agent](react-react-agent/README.md) | React ReAct Agent（真·流式版） | React + Vite | ReAct 推理循环、真·流式输出、工具扩展 |

## 快速开始

### 1. LLM-SSE（SSE 协议最佳实践）

适合需要实现 LLM 流式输出的场景，提供了完整的浏览器端和 Node.js 客户端示例。

```bash
cd LLM-SSE
npm install
# 浏览器示例：直接用浏览器打开 examples/browser.html
# Node CLI：node examples/node-cli.js
```

### 2. react-node-agentic-rag（企业级 Agentic RAG）

适合需要构建复杂 Agent 系统的场景，包含检索增强、记忆管理和 Graph 工作流。

```bash
# 前后端一键启动（开发模式）
cd react-node-agentic-rag
cp backend/.env.example backend/.env   # 填 LLM_API_KEY
./start.sh

# 访问 http://localhost:5174（默认账号 demo/demo123），先在「文档管理」上传文档再提问
```

### 3. react-python-rag（Python RAG 后端）

适合熟悉 Python 技术栈的场景，提供完整的后端 API 和 OCR 文档处理能力。

```bash
cd react-python-rag/frontend
npm install && npm run dev

# 新开终端
cd react-python-rag/backend
pip install -r requirements.txt
uvicorn app:app --reload
```

### 4. react-react-agent（ReAct Agent 前端演示）

适合学习和研究 ReAct 推理模式，通过可视化界面观察 Agent 的思考过程。

```bash
cd react-react-agent
npm install
npm run dev
```

## 技术特性概览

- **LLM-SSE**：支持多厂商 API（OpenAI、Anthropic、Azure 等）、SSE 协议深度兼容、错误处理与重试机制
- **react-node-agentic-rag**：基于 LangGraph 的 Agent 图结构、Qdrant 混合检索（服务端 RRF）、Postgres + Redis（多实例共享态）、RBAC 与引用溯源、MCP Server（stdio/HTTP）、OpenTelemetry 可观测性
- **react-python-rag**：PDF/Word 文档 OCR 解析、Chroma/Weaviate 向量库、FastAPI 异步后端
- **react-react-agent**：Langfuse 观测集成、动态工具系统、流式 Token 逐字输出

## License

MIT License