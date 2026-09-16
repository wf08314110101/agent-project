// ============================================================================
// SQLite → Postgres 一次性数据迁移（阶段1 产品化）
// 运行：cd backend && node scripts/migrate-sqlite-to-pg.mjs
// ----------------------------------------------------------------------------
// 从 backend/data/app.db 读取 5 张表全量数据，写入 DATABASE_URL 指向的 Postgres。
// 幂等策略：先 TRUNCATE 目标表（保留表结构），再整体导入（可重复执行）。
// chat_messages.seq 用显式值插入后 setval 校准 IDENTITY 序列，避免后续插入主键冲突。
// ============================================================================

import Database from 'better-sqlite3'
import pg from 'pg'
import 'dotenv/config'
// 引入 store/pg.js 触发建表（CREATE TABLE IF NOT EXISTS，幂等），await 确保先于导入
import { schemaReady, closePool } from '../src/store/pg.js'
await schemaReady

// SQLite 源路径：config 已不含 sqlitePath（迁移期从 env 直读），默认老库位置
const sqlitePath = process.env.SQLITE_PATH || './data/app.db'
const sqlite = new Database(sqlitePath, { readonly: true })
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://rag:rag123@localhost:5432/rag' })

const client = await pool.connect()

// JSONB 严格校验：LLM 流式切出的孤立代理对 → U+FFFD；PDF 解析残留的 \u0000（PG 拒绝）→ 删除
const cleanStr = (v) => typeof v === 'string'
  ? v.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
  : v
const safeJson = (s) => {
  if (s == null) return null
  try { return JSON.stringify(JSON.parse(s, (k, x) => cleanStr(x))) } catch { return null }
}

try {
  await client.query('BEGIN')
  // 顺序：先清子表/引用表，避免外键/主键残留干扰
  await client.query('TRUNCATE doc_grants, chat_messages, sessions, documents, users')

  // users
  const users = sqlite.prepare('SELECT id, username, pass_hash, role, dept, created_at FROM users').all()
  for (const u of users) {
    await client.query(
      'INSERT INTO users (id, username, pass_hash, role, dept, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [u.id, u.username, u.pass_hash, u.role ?? 'member', u.dept ?? '', u.created_at]
    )
  }

  // documents（tags 是 JSON 字符串，::jsonb 直接入列）
  const docs = sqlite.prepare('SELECT * FROM documents').all()
  for (const d of docs) {
    await client.query(
      `INSERT INTO documents (id, filename, size, hash, chunks, status, error, path, user_id, classification, tags, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [d.id, d.filename, d.size, d.hash, d.chunks, d.status, d.error ?? null, d.path ?? null,
        d.user_id ?? '', d.classification ?? 'public', safeJson(d.tags) ?? '[]', d.created_at]
    )
  }

  // doc_grants
  const grants = sqlite.prepare('SELECT doc_id, user_id FROM doc_grants').all()
  for (const g of grants) {
    await client.query('INSERT INTO doc_grants (doc_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.doc_id, g.user_id])
  }

  // sessions（历史列 summarized_count 可能存在，按需挑选）
  const sessions = sqlite.prepare('SELECT id, title, user_id, summary, summarized_seq, created_at FROM sessions').all()
  for (const s of sessions) {
    await client.query(
      'INSERT INTO sessions (id, title, user_id, summary, summarized_seq, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [s.id, s.title, s.user_id ?? '', s.summary ?? '', s.summarized_seq ?? 0, s.created_at]
    )
  }

  // chat_messages（meta JSON 字符串 → jsonb；seq 显式插入保序）
  const msgs = sqlite.prepare('SELECT seq, session_id, role, content, meta, created_at FROM chat_messages ORDER BY seq').all()
  for (const m of msgs) {
    await client.query(
      `INSERT INTO chat_messages (seq, session_id, role, content, meta, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [m.seq, m.session_id, m.role, m.content, safeJson(m.meta), m.created_at]
    )
  }
  // 校准 IDENTITY 序列到当前最大 seq
  await client.query(
    `SELECT setval(pg_get_serial_sequence('chat_messages','seq'), COALESCE((SELECT MAX(seq) FROM chat_messages), 1))`
  )

  await client.query('COMMIT')
  console.log(`[migrate] 完成：users=${users.length} documents=${docs.length} grants=${grants.length} sessions=${sessions.length} messages=${msgs.length}`)
} catch (e) {
  await client.query('ROLLBACK')
  console.error('[migrate] 失败，已回滚:', e.message)
  process.exitCode = 1
} finally {
  client.release()
  sqlite.close()
  await pool.end()
  await closePool() // 关闭 store/pg.js 的共享连接池
}
