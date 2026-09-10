# React ReAct Agent（真实流式版）

一个用 **React + Vite** 实现的最小 ReAct（Reasoning + Acting）智能体骨架，带你理解 Agent 的核心：**while 循环 + Thought/Action/Observation + 真实工具调用 + 防死循环兜底**，并支持**真·流式输出**与**用时 / Token 消耗统计**。

## 功能

- 调用真实大模型（DeepSeek，OpenAI 兼容接口），**真流式**（`stream: true` + SSE，token 逐字到达即渲染）
- 通过 Function Calling 调用外部工具（计算器 / 运势模拟）
- 循环逐步输出：Thought → Action → Observation → Final Answer
- **最大循环次数兜底**（防止无限死循环）
- **结束汇总**：总用时 + Token 消耗（输入 / 输出）
- 支持手动停止（AbortController）
- Vite 代理 `/api` 绕开浏览器 CORS，API Key 走 `.env` 不暴露到页面

## 目录结构

```
react-react-agent/
├── index.html          # HTML 入口
├── vite.config.js      # /api 代理，绕 CORS
├── .env.example        # 环境变量示例（复制为 .env）
└── src/
    ├── main.jsx        # React 入口
    ├── AgentConsole.jsx# UI：输入框 + 运行/停止 + 实时流式日志
    ├── agent.js        # ⭐ ReAct while 主循环（核心逻辑）+ 计时/token 汇总
    ├── llm.js          # 真实流式 LLM 调用（SSE 解析 + include_usage）
    ├── tools.js        # 工具定义 + 工具实现（Action 分发点）
    └── utils.js        # 参数解析辅助
```

## 快速开始

```bash
cd react-react-agent
npm install            # 安装依赖
cp .env.example .env   # 填入 VITE_API_KEY
npm run dev            # 打开 http://localhost:5173
```

`.env`：

```env
VITE_API_KEY=sk-你的key

# 可选：Langfuse 观测（三个都填才开启）
VITE_LANGFUSE_HOST=https://cloud.langfuse.com
VITE_LANGFUSE_PUBLIC_KEY=pk-lf-xxx
VITE_LANGFUSE_SECRET_KEY=sk-lf-xxx
```

模型与接口地址在 [src/llm.js](src/llm.js) 顶部的 `CFG` 配置：

```js
const CFG = {
  apiBase: '/api/v1',            // 走 vite 代理；生产改为后端真实地址
  model: 'deepseek-chat',        // 你的 DS v4 flash 模型 id
  apiKey: import.meta.env.VITE_API_KEY ?? 'sk-xxxxxx',
}
```

## ReAct 核心循环

`agent.js` 是全部循环逻辑所在，与 UI 完全解耦。三层分离便于逐个学习：

| 概念 | 对应代码 | 作用 |
|------|---------|------|
| while 循环 | `agent.js` 里 `while(true)` | 每轮 = 一次「问模型 + 可能调工具 + 回填观测」，把推理逐步推进 |
| Thought | 模型内部推理，流式返回 `content` | 决定下一步做什么 |
| Action + Input | `tc.function.name` / `tc.function.arguments` | 选哪个工具、传什么参（工具名同样流式显示） |
| Observation | 工具返回值回填 `role:'tool'`（带 `tool_call_id` 配对） | 成为下一轮思考的上下文，形成闭环 |
| 终止条件① | 无 `tool_calls` 且返回 `content` | 正常完成任务 |
| 终止条件② | `step >= maxIterations` | 兜底，防止模型重复同一 Action 造成无限死循环 |

```
循环开始
  │
  ├─ step >= maxIterations? ──> 终止（防死循环，汇总用时/token）
  │
  ├─ 流式问模型（Thought → 正文逐 token、工具名逐字）
  │
  ├─ 有 tool_calls?
  │     ├─ 是：执行工具 → 流式打印 Observation → 回填上下文 → continue 回循环顶
  │     └─ 否：返回 Final Answer → 汇总结束
```

## 真·流式是怎么实现的

关键在 [src/llm.js](src/llm.js)：

1. 请求体加 `stream: true`，响应是 SSE 事件流；
2. 用 `res.body` 的 `ReadableStream` 逐行解析，每来一个 token 立即调 `onDelta` 推给 UI（正文 `content` 与工具名 `name` 分片都即时渲染）；
3. tool_calls 的 `name` / `arguments` 可能跨多个 chunk 分片，用 `index` 累积拼接回完整调用；
4. Token 消耗：`stream_options: { include_usage: true }`，在流结束前的 usage 帧（`choices` 为空）里读取，比依赖 `x-*` 响应头更可靠（代理常吞掉自定义头）。

## 用时与 Token 消耗

`agent.js` 里 `startedAt` 记起点，每轮累加 `assistantMsg.usage`，结束时统一打印：

```
✅ 任务完成
⏱️ 总用时 3.42s ｜ 🧮 Token 消耗: 1256 (输入 890 + 输出 366)
```

## 如何扩展新工具

在 [src/tools.js](src/tools.js) 里加两处即可：

1. `tools` 数组：加一条工具定义（名字 + 描述 + 参数 schema），模型靠它知道能不能调；
2. `toolImpl` 对象：实现同名异步函数，参数即 Action Input。

```js
export const toolImpl = {
  async my_tool({ arg1 }) {
    return '真实执行结果'
  },
}
```

## 学习建议

- 先只读 `agent.js`，理解循环与两个终止条件，以及计时/token 汇总；
- 再读 `llm.js` 看流式 SSE 如何解析、usage 帧如何读；
- 最后看 `tools.js` 看 Action 如何分发，`AgentConsole.jsx` 看 token 如何驱动 UI。

## 说明

- 浏览器端直接用真实 Key 仅适合本地学习，**生产必须在后端调用**，前端只请求自己的服务。
- 计算器用「正则白名单 + `Function` 构造器」实现，比 `eval` 略安全，仅演示。
- 运势工具为为真实 API。
- 若你的 provider 不支持 `include_usage`（usage 仍显示 0），代码会自动退回响应头 `x-prompt-tokens` 等字段兜底。