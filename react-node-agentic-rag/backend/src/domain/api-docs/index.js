// ============================================================================
// 领域包①：API 文档助手（M17 五件套：语料结构 / 切分策略 / 提示片段 / 工具集 / 评测集）
// ----------------------------------------------------------------------------
// 本文件是唯一对外描述符（registry 消费），领域知识不外泄到内核。
// 语料结构 = documents 表 M17 列（collection/source_url/doc_version/deprecated）
//           + payload 随行字段（ingest.js extraPayload 机制）；此处仅声明归属集合。
// ============================================================================

import { toolDefs, handlers } from './tools.js'
import { chunkApiDoc } from './chunker.js'
import { promptFragment } from './prompts.js'
import { syncOnce } from './connector.js'
import { pack } from './meta.js'
import { config } from '../../config.js'

export default {
  name: 'api-docs',
  collection: pack.collection,              // 领域自治集合：一领域一集合（rag_api_docs）
  toolDefs,
  handlers,
  promptFragment,
  tagWhitelist: ['接口规范', 'SDK', '变更记录'], // 覆盖内核 core 词表（机制留内核，词表归领域）
  chunker: chunkApiDoc,
  connector: {
    run: syncOnce,
    // 定时同步间隔；0/未配置 = 不注册定时（仍可 npm run domain:sync 手动触发）
    intervalMs: config.domain.syncIntervalMin > 0 ? config.domain.syncIntervalMin * 60_000 : 0,
  },
}
