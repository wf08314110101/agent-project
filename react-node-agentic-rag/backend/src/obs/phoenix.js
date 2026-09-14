// ============================================================================
// Phoenix 观测：PHOENIX_ENABLED=true 时启 OTel，手动打 OpenInference 规范 span
// ----------------------------------------------------------------------------
// span kind 可选值：AGENT / TOOL / RETRIEVER / LLM / CHAIN
// 设计要点：
//   1. initOtel 只在首次调用且开关打开时初始化 SDK（幂等）；
//   2. otelSpan 未启用时返回 no-op 对象，业务代码免判空（与 langfuse.js 同思路）；
//   3. span 命名遵循 OpenInference 语义（如 tool.search_knowledge / agent.round-1），
//      Phoenix UI 可按 kind 分类展示调用树。
// ============================================================================

import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources' // otel v2 API
import { trace } from '@opentelemetry/api'
import { config } from '../config.js'

let started = false // 幂等守卫：防止重复初始化 SDK

/**
 * 初始化 OpenTelemetry SDK：trace 经 OTLP 导出到 Phoenix
 * 在 server.js 顶部调用（早于任何业务请求）
 */
export function initOtel() {
  if (started || !config.phoenixEnabled) return
  started = true
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'agentic-rag-backend' }), // 服务标识，UI 按此分组
    traceExporter: new OTLPTraceExporter({ url: config.phoenixEndpoint }),
  })
  sdk.start()
  console.log(`[phoenix] OTel 已启用 → ${config.phoenixEndpoint}`)
}

// 未启用时的 no-op：接口与真实 span 控制器一致
const noop = { setAttr: () => {}, end: () => {} }

/**
 * 手动创建一个 span（开箱即用的计时与属性上报）
 * @param {string} name  - span 名称（如 `tool.${工具名}`）
 * @param {string} kind  - OpenInference span kind：AGENT/TOOL/RETRIEVER/LLM/CHAIN
 * @param {object} attrs - 附加属性（如 llm.model_name / input.value）
 * @returns {{ setAttr: Function, end: Function }} 控制器：setAttr 补属性；end(output) 记录输出并结束
 */
export function otelSpan(name, kind, attrs = {}) {
  if (!config.phoenixEnabled) return noop
  const span = trace.getTracer('agentic-rag').startSpan(name)
  span.setAttributes({ 'openinference.span.kind': kind, ...attrs })
  return {
    setAttr: (k, v) => span.setAttribute(k, v),
    end: (output) => {
      // 有输出则记为 output.value（对象序列化），Phoenix 可直接查看结果
      if (output !== undefined) {
        span.setAttribute('output.value', typeof output === 'string' ? output : JSON.stringify(output))
      }
      span.end()
    },
  }
}
