# LLM-SSE

零依赖的 **LLM 流式 SSE 调用 Demo**，对接 OpenAI 及所有兼容 OpenAI 协议的服务（DeepSeek、Moonshot、智谱、通义兼容模式、Ollama、vLLM、OneAPI 网关等）。

核心是手写 SSE 解析器 + 流式客户端，不依赖任何 npm 包，同一份代码跑在 Node 和浏览器。

## 快速开始

```bash
cd LLM-SSE
npm run cli
```

启动后按向导走三步，**第 1 步选厂商、第 2 步选模型、第 3 步填 Key**，全部用数字选择，不用手敲 URL：

```
第 1 步 / 选择大模型厂商
  1. OpenAI  →  https://api.openai.com/v1
  2. DeepSeek 深度求索  →  https://api.deepseek.com/v1
  3. Moonshot / Kimi 月之暗面  →  https://api.moonshot.cn/v1
  4. 智谱 GLM  →  https://open.bigmodel.cn/api/paas/v4
  5. 通义千问（阿里云百炼）  →  https://dashscope.aliyuncs.com/compatible-mode/v1
  6. 硅基流动 SiliconFlow  →  https://api.siliconflow.cn/v1
  7. 火山方舟（豆包）  →  https://ark.cn-beijing.volces.com/api/v3
  8. Ollama 本地  →  http://localhost:11434/v1
  9. 自定义 / 兼容网关（OneAPI、NewAPI、vLLM…）
请输入序号 [1]:

第 2 步 / 选择模型     ← 数字选，或直接手敲模型名
第 3 步 / 输入 API Key ← 选 Ollama / 本地地址时自动跳过
```

向导最后会问是否写入 `.env`，写好后下次启动直接跳过配置。想重选就加 `--setup`，对话中输入 `/setup` 也能重来。

不想配 Key 也想看效果？仓库自带假 LLM：

```bash
npm run mock                                                   # 终端 A
node examples/node-cli.js --setup                              # 终端 B：第 1 步选 9，baseURL 填 http://127.0.0.1:8787/v1，模型随意
```

浏览器 Demo（ES module 需要 http 协议，不能直接 file:// 打开）：

```bash
npm run web              # 打开 http://127.0.0.1:5173/examples/browser.html
```

网页版的三个下拉框同样来自 `src/providers.js`，配置存 localStorage。

## 目录

```
src/
  providers.js      厂商预设：baseURL + 模型清单 + Key 申请地址（三步配置的数据源）
  sse-parser.js     通用 SSE 解码器（async generator / TransformStream 两种形态）
  llm-client.js     chatStream() / chat() / createClient()，OpenAI 协议
  chat-session.js   多轮对话会话，自动维护 messages 上下文
  utils.js          .env 加载、耗时与速度格式化
examples/
  node-cli.js       三步配置向导 + 终端打字机 + Ctrl+C 中断 + /setup /clear /messages
  browser.html      网页版：厂商/模型下拉选择、打字机、停止按钮、tok/s 统计
  mock-sse-server.js 本地假 LLM，刻意碎片化发包 + 心跳，用于压测解析器
  static-server.js  开发用静态服务
```

## 新增或修正厂商

改 `src/providers.js` 里的 `PROVIDERS` 数组即可，字段含义：

| 字段 | 说明 |
|---|---|
| `id` / `name` | 标识与显示名 |
| `baseURL` | 该厂商的 OpenAI 兼容端点 |
| `models` | 模型下拉列表，留空则让用户手填（如火山方舟的接入点 ID） |
| `defaultModel` / `modelPlaceholder` | 默认选中项 / 手填时的输入提示 |
| `keyRequired` | 设 `false` 跳过第 3 步（Ollama 等本地服务） |
| `keyUrl` / `note` | Key 申请地址、注意事项提示 |

⚠️ 模型名变化很快（DeepSeek 的 `deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 停用，Kimi 的 `moonshot-v1-*` 也已停止新用户开放）。列表最后核对时间 2026-09，以厂商控制台为准。

## API

```js
import { chatStream, ChatSession } from './index.js';

// 底层：逐 delta 消费
for await (const ev of chatStream({
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '你好' }],
  signal: controller.signal,
})) {
  if (ev.type === 'delta') process.stdout.write(ev.delta); // 增量文本
  if (ev.type === 'done') console.log(ev.text, ev.usage);  // 全文 + usage
}

// 上层：多轮会话
const session = new ChatSession({ apiKey: '...', model: 'gpt-4o-mini', maxTurns: 10 });
await session.send('第一句', { onDelta: (d, full) => render(full) });
await session.send('接着上一句说', { onDelta: (d, full) => render(full) });
```

`chatStream` 的 `streamOptions` 默认 `{ include_usage: true }`；传 `null` 可关闭（部分兼容方不认这个字段）。

## SSE 协议要点

服务端响应 `Content-Type: text/event-stream`，一帧一帧往下写：

```
data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"你"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"好"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]

```

- 帧以**空行**结束；字段行形如 `field: value`，冒号后可跟一个空格；`data` 多行用 `\n` 拼接；`:` 开头是注释（心跳）。
- 行分隔符 `\n`、`\r\n`、`\r` 三种都合法。
- 结束标记是 `data: [DONE]`（部分厂商带尾随空格，代码里一律 trim 后比较）。

## 踩坑清单（代码里都已处理）

| 坑 | 处理方式 |
|---|---|
| `EventSource` 只能 GET、不能带 `Authorization` | 浏览器端用 `fetch` + `ReadableStream` 自己解 |
| TCP 分包：一次 chunk 可能含多帧，也可能把一帧切两半 | 维护 buffer，见到空行才派发一帧 |
| UTF-8 中文跨 chunk 被截断 → 乱码 | `TextDecoder.decode(chunk, { stream: true })` |
| 4xx 时响应体是 JSON 不是 SSE | 先判 `res.ok`，再决定按 JSON 还是按流读 |
| usage 帧 `choices` 是空数组 | 取 `choices[0]` 前先判空 |
| 网关忽略 `stream` 参数直接返 JSON | 按 `content-type` 兜底走非流式分支 |
| 部分网关返回 `event: error` 帧 | 收到即抛 `LLMError` |
| 心跳帧 / 脏帧 | 空 `data` 跳过，`JSON.parse` 失败跳过而非中断流 |
| Nginx 默认缓冲会憋住流 | 请求头带 `X-Accel-Buffering: no`，服务端配 `proxy_buffering off` |
| 浏览器直连会暴露 API Key | 生产请自建后端代理转发，或在网关配 CORS 白名单 |
| 中断后上下文断裂 | `AbortError` 时已生成的部分仍入上下文 |

## 三方库对比（生产环境选型参考）

| 方案 | 优点 | 缺点 |
|---|---|---|
| 本仓库手写解析器 | 零依赖、可控、可调试、能看到协议细节 | 需自己维护边缘情况 |
| `eventsource-parser`（Vercel） | 成熟、AI SDK 在用、体积很小 | 多一层依赖 |
| `@microsoft/fetch-event-source` | 支持 POST + 自定义 header + 自动重连 | 为浏览器设计，Node 端体验一般 |
| `openai` 官方 SDK | 开箱即用，自动处理重试、类型完整 | 屏蔽了 SSE 细节，且旧版本不暴露 `reasoning_content` 等新字段 |

如果只是要跑通业务，用官方 SDK；如果要理解或定制流式链路，用本仓库这套。
