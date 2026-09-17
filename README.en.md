# Agent Project

This is a repository containing multiple AI Agent-related sub-projects, covering core scenarios such as LLM streaming communication, Agentic RAG (Retrieval-Augmented Generation), and ReAct Agents. Each sub-project is a complete, independently runnable application, allowing you to choose the corresponding tech stack for learning and usage based on your needs.

## Project Structure

| Sub-project | Description | Tech Stack | Core Functions |
|--------|------|--------|----------|
| [LLM-SSE](LLM-SSE/README.md) | Complete solution for LLM streaming output | Node.js | Multi-vendor API compatibility, SSE protocol encapsulation, Browser/CLI examples |
| [react-node-agentic-rag](react-node-agentic-rag/README.md) | React + Node.js Agentic RAG | React + Node.js + LangGraph | Graph-based Agent (ReAct loop), Hybrid retrieval (dense+sparse RRF), RBAC classification, MCP Server, Full-chain observability |
| [react-python-rag](react-python-rag/README.md) | Python RAG backend implementation | FastAPI + Python | PDF/Word OCR, Vector search, Streaming generation |
| [react-react-agent](react-react-agent/README.md) | React ReAct Agent (True Streaming Version) | React + Vite | ReAct inference loop, True streaming output, Tool extension |

## Quick Start

### 1. LLM-SSE (SSE Protocol Best Practices)

Suitable for scenarios requiring implementation of LLM streaming output, providing complete browser-side and Node.js client examples.

```bash
cd LLM-SSE
npm install
# Browser example: open examples/browser.html directly in browser
# Node CLI: node examples/node-cli.js
```

### 2. react-node-agentic-rag (Enterprise-level Agentic RAG)

Suitable for scenarios requiring building complex Agent systems, including retrieval augmentation, memory management, and Graph workflows.

```bash
# One-click start for frontend and backend (Development mode)
cd react-node-agentic-rag
cp backend/.env.example backend/.env   # fill in LLM_API_KEY
./start.sh

# Visit http://localhost:5174 (default account demo/demo123); upload documents first, then ask questions
```

### 3. react-python-rag (Python RAG Backend)

Suitable for scenarios familiar with the Python tech stack, providing complete backend API and OCR document processing capabilities.

```bash
cd react-python-rag/frontend
npm install && npm run dev

# Open a new terminal
cd react-python-rag/backend
pip install -r requirements.txt
uvicorn app:app --reload
```

### 4. react-react-agent (ReAct Agent Frontend Demo)

Suitable for learning and studying the ReAct reasoning pattern, observing the Agent's thought process through a visual interface.

```bash
cd react-react-agent
npm install
npm run dev
```

## Technical Features Overview

- **LLM-SSE**: Supports multi-vendor APIs (OpenAI, Anthropic, Azure, etc.), deep SSE protocol compatibility, error handling and retry mechanisms
- **react-node-agentic-rag**: LangGraph-based Agent graph, Qdrant hybrid retrieval (server-side RRF), Postgres + Redis (multi-instance shared state), RBAC with citation traceability, MCP Server (stdio/HTTP), OpenTelemetry observability
- **react-python-rag**: PDF/Word document OCR parsing, Chroma/Weaviate vector databases, FastAPI async backend
- **react-react-agent**: Langfuse observation integration, Dynamic tool system, Streaming token character-by-character output

## License

MIT License