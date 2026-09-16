// ============================================================================
// 调试路由：GET /api/debug/retrieval —— 裸检索观测口（M6 评估体系配套）
// ----------------------------------------------------------------------------
// 与 /api/chat 的区别：不走 Agent/评估/改写/LLM，一步式 retrieve() 直接返回
// 混合检索原始命中（分数/标题/文本/模式）。用途：
//   1. evaluate.mjs 的检索层指标数据源（recall@k / MRR）
//   2. 人工调参时直观查看 RETRIEVE_MIN_SCORE / chunk 策略的影响
// 位于受保护路由组内，需 Bearer token。
// ============================================================================

import { retrieve } from '../rag/retriever.js'
import { aclFor } from '../acl.js'

export default async function (app) {
  app.get('/api/debug/retrieval', async (req, reply) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) return reply.code(400).send({ error: 'q 必填' })
    const topK = Math.min(Number(req.query.topK) || 5, 20) // 上限 20，防滥用拉全库
    const docId = String(req.query.docId ?? '').trim() || undefined // 可选：单文档范围观测

    const started = Date.now()
    // M10 RBAC：调试口同样受 ACL 约束（admin 全通；member 只看可读资料），避免观测口绕过权限
    const hits = await retrieve(q, topK, docId, await aclFor(req.user))
    return {
      query: q,
      topK,
      elapsedMs: Date.now() - started,
      hits: hits.map((h) => ({
        score: Number(h.score?.toFixed?.(4) ?? h.score),
        title: h.title ?? '',
        filename: h.filename ?? '',
        chunkIndex: h.chunkIndex,
        text: h.text,
      })),
    }
  })
}
