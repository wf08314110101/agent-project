// Phoenix 观测：PHOENIX_ENABLED=true 时启 OTel，手动打 OpenInference 规范 span
// span kind 可选值：AGENT / TOOL / RETRIEVER / LLM / CHAIN
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources' // otel v2 API
import { trace } from '@opentelemetry/api'
import { config } from '../config.js'

let started = false

export function initOtel() {
  if (started || !config.phoenixEnabled) return
  started = true
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'agentic-rag-backend' }),
    traceExporter: new OTLPTraceExporter({ url: config.phoenixEndpoint }),
  })
  sdk.start()
  console.log(`[phoenix] OTel 已启用 → ${config.phoenixEndpoint}`)
}

const noop = { setAttr: () => {}, end: () => {} }

export function otelSpan(name, kind, attrs = {}) {
  if (!config.phoenixEnabled) return noop
  const span = trace.getTracer('agentic-rag').startSpan(name)
  span.setAttributes({ 'openinference.span.kind': kind, ...attrs })
  return {
    setAttr: (k, v) => span.setAttribute(k, v),
    end: (output) => {
      if (output !== undefined) {
        span.setAttribute('output.value', typeof output === 'string' ? output : JSON.stringify(output))
      }
      span.end()
    },
  }
}
