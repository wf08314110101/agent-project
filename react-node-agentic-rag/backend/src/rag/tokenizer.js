// ============================================================================
// 中文分词 + 稀疏向量构建（BM25 路的原料）
// ----------------------------------------------------------------------------
// 分词：@node-rs/jieba（napi 预编译，需显式加载内置词典，否则全切成单字）
// 词表：hash 技巧 —— term → fnv1a(term) % 2^31 直接当词 id，
//       摄取端与查询端一致且免持久化；本库规模下碰撞概率可忽略
// 输出：Qdrant sparse vector { indices, values }，values 为词频（TF），
//       IDF 权重由 Qdrant 稀疏向量的 modifier:'idf' 在服务端完成
// ============================================================================

import { Jieba } from '@node-rs/jieba'
import dictPkg from '@node-rs/jieba/dict.js'

const jieba = Jieba.withDict(dictPkg.dict)

// 高频虚词停用：对 BM25 只有稀释作用（占比高、无区分度）
const STOP = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一个', '也',
  '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '这', '那',
  '与', '及', '或', '等', '对', '为', '以', '于', '从', '被', '把', '让', '用',
  '上', '下', '中', '里', '吗', '呢', '吧', '啊', '什么', '怎么', '哪些', '如何',
  '请', '可以', '一下', '关于', '进行', '通过', '如果', '因为', '所以', '但是',
])

// 纯符号/空白过滤（标点、emoji、运算符等，对字面匹配无意义）
const NOISE = /^[\s\p{P}\p{S}]+$/u

/** 分词：jieba 切分 → 小写 → 滤停用词与纯符号 */
export function tokenize(text) {
  return (jieba.cut(String(text ?? '')) ?? [])
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && !NOISE.test(w) && !STOP.has(w))
}

// FNV-1a 32 位哈希 → 非 0 词 id（Qdrant 稀疏下标为 u32，2^31 内避开符号位）
function termId(term) {
  let h = 0x811c9dc5
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 0x7fffffff) || 1
}

/**
 * 文本 → 稀疏向量：分词 → 词频统计 → { indices, values }
 * 同一文本在摄取与查询两次调用结果一致（hash 词表无状态）
 */
export function toSparse(text) {
  const tf = new Map()
  for (const w of tokenize(text)) tf.set(w, (tf.get(w) ?? 0) + 1)
  const indices = []
  const values = []
  for (const [w, n] of tf) {
    indices.push(termId(w))
    values.push(n)
  }
  return { indices, values }
}
