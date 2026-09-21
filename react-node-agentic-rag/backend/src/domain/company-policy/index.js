// ============================================================================
// 领域包②：企业制度助手（M21 五件套：语料结构 / 切分策略 / 提示片段 / 评测集）
// ----------------------------------------------------------------------------
// 本文件是唯一对外描述符（registry 消费）。与 api-docs 的差异：
//   - 无领域工具、无连接器：制度语料经上传/写工具（M20）进入，本包只提供
//     集合归属 + 条款式切分 + 提示片段 + 标签词表（验证五件套可裁剪可复制）
// 语料结构 = documents 表 M17/M18 列（collection/docKey/doc_version/deprecated/effective_date）
// ============================================================================

import { chunkPolicy } from './chunker.js'
import { promptFragment } from './prompts.js'
import { pack } from './meta.js'

export default {
  name: 'company-policy',
  collection: pack.collection, // 领域自治集合：一领域一集合（rag_company_policy）
  promptFragment,
  tagWhitelist: ['制度规范', '考勤', '报销', '差旅', '信息安全', '采购'], // 覆盖内核 core 词表
  chunker: chunkPolicy,
}
