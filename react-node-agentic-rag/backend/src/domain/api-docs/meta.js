// ============================================================================
// 领域元信息（api-docs）：连接器语料源配置 + 集合归属（index.js 与 scripts 共用）
// ============================================================================

// 语料源：默认 Vue 官方中文文档仓库（纯 md、结构规整、中文嵌入模型友好）
const REPO = process.env.DOMAIN_SYNC_REPO ?? 'vuejs-translations/docs-zh-cn'
const BRANCH = process.env.DOMAIN_SYNC_BRANCH ?? 'main'
const DIR = process.env.DOMAIN_SYNC_DIR ?? 'src/'
const DEPRECATED_DIR = process.env.DOMAIN_SYNC_DEPRECATED_DIR ?? '' // 如 'src/versions/'（留空 = 无废弃区）

export const pack = {
  repo: REPO,
  branch: BRANCH,
  dir: DIR,
  deprecatedDir: DEPRECATED_DIR,
  collection: 'rag_api_docs',
  tags: ['接口规范'],
}
