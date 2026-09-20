// ============================================================================
// RBAC 访问控制单点（M10）：密级判定 + 标签白名单 + 检索 ACL 组装
// ----------------------------------------------------------------------------
// 原则：
//   1. canReadDoc 是唯一的「能否读文档」判定入口，所有读路径（问答/详情/授权）必须走它；
//   2. 不可读一律按 404 处理（由调用方实现），不泄露文档存在性；
//   3. 密级必须在 Qdrant 召回前服务端过滤（aclFor → hybridSearch），检索后隐藏等于没保护。
// 密级三级：public（全体登录用户）/ dept（同 owner 部门）/ private（仅 owner + 显式授权）
// ============================================================================

import { getUserById, listGrantsForUser } from './store/pg.js'

// 受控枚举：密级是通用 RBAC 机制（内核）；标签词表是业务词汇（M17 起由领域包经
// setTagWhitelist 注入，缺省 core 词表）——机制与词表分离，领域可插拔。
export const CLASSIFICATIONS = ['public', 'dept', 'private']
export const CLS_LABEL = { public: '公开', dept: '部门', private: '私有' }

// core 缺省词表：与 evals/fixtures core 语料匹配；启用领域包时被 registry 覆盖
const CORE_TAGS = ['技术方案', '制度', '会议纪要', '运维', '竞品', '测试']
let tagWhitelist = CORE_TAGS

/** 注入标签词表（M17）：领域包启动时调用，替换内核缺省词表 */
export function setTagWhitelist(tags) {
  if (Array.isArray(tags) && tags.length) tagWhitelist = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))]
}
export const getTagWhitelist = () => tagWhitelist

/** 标签清洗：白名单过滤 + 去重，返回合法标签数组 */
export function sanitizeTags(tags) {
  const arr = (Array.isArray(tags) ? tags : String(tags ?? '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean)
  return [...new Set(arr.filter((t) => tagWhitelist.includes(t)))]
}

/**
 * 唯一可读性判定：user 能否读 doc。
 * @param {object} user - { id|sub, role, dept }（req.user，role/dept 每请求查库实时值）
 * @param {object} doc  - documents 行（需含 user_id / classification）
 * 规则：admin 全通 → 本人 → public → dept 同部门 → 显式授权（doc_grants）
 */
export async function canReadDoc(user, doc) {
  if (!user || !doc) return false
  const uid = user.sub ?? user.id
  if (user.role === 'admin' || doc.user_id === uid) return true
  if (doc.classification === 'public') return true
  if (doc.classification === 'dept') {
    const owner = await getUserById(doc.user_id)
    if (owner?.dept && owner.dept === user.dept) return true
  }
  // 显式授权兜底（对 dept/private 同样生效：授权只增不减，无安全洞）
  const grants = await listGrantsForUser(uid)
  return grants.some((g) => g.doc_id === doc.id)
}

/**
 * 检索 ACL：把用户身份翻译成 hybridSearch 的服务端过滤条件。
 * admin 返回 role:'admin'（检索侧跳过过滤）；member 附带显式授权的 docId 集合。
 * 缺省（无用户上下文的脚本/评估直连）返回 null = 不过滤。
 */
export async function aclFor(user) {
  if (!user) return null
  const uid = user.sub ?? user.id
  if (user.role === 'admin') return { userId: uid, role: 'admin', dept: user.dept ?? '' }
  const grants = await listGrantsForUser(uid)
  return {
    userId: uid,
    role: user.role ?? 'member',
    dept: user.dept ?? '',
    grants: grants.map((g) => g.doc_id),
  }
}
