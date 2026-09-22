import { readFile } from 'node:fs/promises';
import { cfg } from '../../server/config.js';

// 截图 → 文字描述（vision 模型），失败返回 null 不阻塞修复
export async function describeImage(filePath) {
  if (!cfg.visionModel || !cfg.openaiApiKey || !cfg.openaiApiBase) return null;
  try {
    const buf = await readFile(filePath);
    const res = await fetch(`${cfg.openaiApiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.visionModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '客观描述这张截图里的界面与异常现象（中文，200 字内），供后续修复 BUG 使用。只描述事实。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${buf.toString('base64')}` } },
          ],
        }],
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`vision ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn(`[vision] 截图转述失败: ${e.message}`);
    return null;
  }
}
