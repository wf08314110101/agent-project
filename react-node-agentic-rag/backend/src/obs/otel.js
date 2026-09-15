// ============================================================================
// 统一观测层（M4）：单一 OTel 管道 + 多后端扇出（Phoenix / Langfuse）
// ----------------------------------------------------------------------------
// 一次埋点同时导出到多个后端：NodeSDK.spanProcessors 挂多个 BatchSpanProcessor
//   - Phoenix : OpenInference 规范（span kind / input.value / output.value）
//   - Langfuse: OTLP 摄入（/api/public/otel/v1/traces），同一套属性自动映射：
//       openinference.span.kind → 观测类型（LLM/TOOL/RETRIEVER…）
//       llm.model_name / llm.token_count.prompt|completion|total → 模型与 usage
//       langfuse.trace.name / langfuse.session.id → trace 命名与会话分组
// 设计要点：
//   1. initObs() 幂等，server.js 启动时调用；两个后端按配置各自启用；
//   2. 观测全关时 otelSpan 返回 no-op 控制器，业务代码免判空；
//   3. flushObs() 在请求收尾/进程退出时强推 BatchSpanProcessor，防丢数据。
// ============================================================================

import { NodeSDK } from '@opentelemetry/sdk-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources' // otel v2 API
import { trace, context } from '@opentelemetry/api'
import { config } from '../config.js'

let processors = [] // 保留引用：flushObs 时逐个 forceFlush
let enabled = false

// Langfuse OTLP 可用性：host + publicKey + secretKey 三项齐全才启用
const lfEnabled = () => !!(config.langfuse.host && config.langfuse.publicKey && config.langfuse.secretKey)

/**
 * 初始化观测 SDK：一次埋点，按配置扇出到 Phoenix / Langfuse
 * 在 server.js 顶部调用（早于任何业务请求）
 */
export function initObs() {
  if (enabled) return
  const targets = []
  if (config.phoenixEnabled) targets.push(new OTLPTraceExporter({ url: config.phoenixEndpoint }))
  if (lfEnabled()) {
    const auth = Buffer.from(`${config.langfuse.publicKey}:${config.langfuse.secretKey}`).toString('base64')
    targets.push(
      new OTLPTraceExporter({
        url: `${config.langfuse.host.replace(/\/+$/, '')}/api/public/otel/v1/traces`,
        headers: { authorization: `Basic ${auth}` },
      })
    )
  }
  if (!targets.length) return // 观测全关：跳过 SDK 初始化

  processors = targets.map((exporter) => new BatchSpanProcessor(exporter))
  new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'agentic-rag-backend' }), // 服务标识，UI 按此分组
    spanProcessors: processors,
  }).start()
  enabled = true
  console.log(`[otel] 观测已启用：${targets.length} 个导出目标（Phoenix/Langfuse 按配置）`)
}

// 未启用时的 no-op 控制器：与真实 span 控制器同接口，业务代码免判空
const noop = { setAttr: () => { }, end: () => { } }

/**
 * 创建 span（一次埋点，双后端可见）
 * @param {string} name  - span 名称（如 tool.search_knowledge / agent.round-1）
 * @param {string} kind  - OpenInference span kind：AGENT/TOOL/RETRIEVER/LLM/CHAIN
 * @param {object} attrs - 附加属性（input.value / llm.model_name / langfuse.* 等）
 * @returns {{ setAttr: Function, end: Function }}
 *   end(output, { usage, level, statusMessage })：记录输出/用量/级别并结束
 */
export function otelSpan(name, kind, attrs = {}) {
  if (!enabled) return noop
  // 不传 parentContext → 自动挂到 context.active()（rootSpan 激活的请求上下文）
  const span = trace.getTracer('agentic-rag').startSpan(name)
  span.setAttributes({ 'openinference.span.kind': kind, ...attrs })
  return {
    setAttr: (k, v) => span.setAttribute(k, v),
    end: (output, { usage, level, statusMessage } = {}) => {
      if (output !== undefined) {
        span.setAttribute('output.value', typeof output === 'string' ? output : JSON.stringify(output))
      }
      if (usage) {
        // OpenInference token 计数属性：Langfuse 自动映射为 usage，Phoenix 原样展示
        if (usage.prompt_tokens) span.setAttribute('llm.token_count.prompt', usage.prompt_tokens)
        if (usage.completion_tokens) span.setAttribute('llm.token_count.completion', usage.completion_tokens)
        if (usage.total_tokens) span.setAttribute('llm.token_count.total', usage.total_tokens)
      }
      if (level) span.setAttribute('langfuse.observation.level', level) // ERROR / WARNING
      if (statusMessage) span.setAttribute('langfuse.status_message', statusMessage)
      span.end()
    },
  }
}

/**
 * 请求级根 span：一条 trace 的入口（Langfuse 里即一条 trace）
 * trace 命名 / 会话分组经 langfuse.* 属性声明
 * 返回控制器额外携带 _ctx，配合 runInCtx 让后续子 span 自动挂到本 span 之下
 */
export function rootSpan(name, attrs = {}) {
  if (!enabled) return noop
  const span = trace.getTracer('agentic-rag').startSpan(name)
  span.setAttributes({ 'openinference.span.kind': 'CHAIN', 'langfuse.trace.name': name, ...attrs })
  const _ctx = trace.setSpan(context.active(), span) // 捕获根上下文
  return {
    _ctx,
    setAttr: (k, v) => span.setAttribute(k, v),
    end: (output) => {
      if (output !== undefined) {
        span.setAttribute('output.value', typeof output === 'string' ? output : JSON.stringify(output))
      }
      span.end()
    },
  }
}

/**
 * 在根 span 的上下文内执行 fn：期间创建的 otelSpan 自动成为其子 span
 * context.with 基于 AsyncLocalStorage，异步链路全程传递且并发请求互不串扰
 */
export const runInCtx = (root, fn) => (root?._ctx ? context.with(root._ctx, fn) : fn())

/** 强推所有 processor（请求收尾/进程退出调用；吞错，观测失败不伤业务） */
export const flushObs = async () => {
  await Promise.all(processors.map((p) => p.forceFlush().catch(() => { })))
}
