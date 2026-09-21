// ============================================================================
// M19 OCR 层：视觉大模型转录（扫描 PDF 逐页 / 独立图片 / docx 内嵌图）
// ----------------------------------------------------------------------------
// OpenAI 兼容 chat.completions + image_url(base64 dataURL)。endpoint/key/model
// 可经 OCR_* 独立配置，缺省复用 LLM_*（视觉模型常与对话模型不同 provider）。
// OCR_MODEL 未配置 = OCR 关闭（ocrEnabled=false，调用方降级跳过，不阻断摄取）。
// OCR_FALLBACK_MODEL = 主模型不可用（429 限流/网络）时的降级模型（如免费 flash 系）。
// 提示词只约束"逐字转录"：OCR 产物直接进检索语料，模型改写/补充 = 语料失真。
// ============================================================================

import OpenAI from 'openai'
import { config } from '../config.js'
import { llm } from '../llm.js'

// OCR 独立客户端：仅当配置了独立 endpoint 时创建（温度 0，转录要稳定）
const client = config.ocr.baseUrl
  ? new OpenAI({
      baseURL: config.ocr.baseUrl,
      apiKey: config.ocr.apiKey || config.llm.apiKey,
      timeout: 120_000, // 视觉转录单页可能较慢
      maxRetries: 2,
    })
  : llm

/** OCR 是否可用 = provider 开启且视觉模型已配置 */
export const ocrEnabled = () => config.ocr.provider === 'vlm' && !!config.ocr.model

const PROMPT =
  '你是 OCR 引擎。逐字转录图片中的全部文字，保持原有结构（标题、列表保留，表格转 Markdown 表格）。' +
  '只输出转录文本，禁止解释、总结、翻译或补充任何内容。图片中没有文字时输出空字符串。'

/**
 * 转录单张图片 → 文本；主模型失败且有 OCR_FALLBACK_MODEL 时降级重试；
 * 仍失败返回 ''（OCR 属尽力增强，不阻断摄取主流程）
 * @param {Buffer} buf  - 图片字节（png/jpeg/webp）
 * @param {string} mime - 图片 MIME（image/png 等）
 */
export async function ocrImage(buf, mime) {
  const r = await transcribe(buf, mime, config.ocr.model)
  if (r.ok) return r.text // 成功但无文字（如纯图案图）≠ 失败，不触发降级
  if (!config.ocr.fallbackModel || config.ocr.fallbackModel === config.ocr.model) return ''
  const fb = await transcribe(buf, mime, config.ocr.fallbackModel)
  return fb.text
}

/** 单次转录：ok 区分「请求成功」（text 可能为空串）与「失败」（429/网络等） */
async function transcribe(buf, mime, model) {
  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    })
    return { ok: true, text: (res.choices?.[0]?.message?.content ?? '').trim() }
  } catch {
    return { ok: false, text: '' }
  }
}
