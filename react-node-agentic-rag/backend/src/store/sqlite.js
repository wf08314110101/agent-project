import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from '../config.js'

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true })
const db = new Database(config.sqlitePath)
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  hash       TEXT UNIQUE NOT NULL,
  chunks     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  meta       TEXT, -- JSON: {sources, usage, steps}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// 老库列迁移（已存在则忽略）
try { db.exec('ALTER TABLE documents ADD COLUMN error TEXT') } catch {}
try { db.exec('ALTER TABLE documents ADD COLUMN path TEXT') } catch {}

export const insertDoc = db.prepare(
  'INSERT INTO documents (id, filename, size, hash, chunks, status, error, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
)
export const listDocs = db.prepare('SELECT * FROM documents ORDER BY created_at DESC')
export const getDoc = db.prepare('SELECT * FROM documents WHERE id = ?')
export const getDocByHash = db.prepare('SELECT * FROM documents WHERE hash = ?')
export const deleteDocRow = db.prepare('DELETE FROM documents WHERE id = ?')
export const setDocStatus = db.prepare('UPDATE documents SET status = ?, error = ? WHERE id = ?')
export const setDocChunks = db.prepare('UPDATE documents SET chunks = ? WHERE id = ?')
// 摄取队列：取最老的一条待处理；重启时把卡在 processing 的重置回 pending（宕机恢复）
export const nextPendingDoc = db.prepare(
  "SELECT * FROM documents WHERE status IN ('pending','processing') ORDER BY created_at ASC LIMIT 1"
)
export const resetProcessing = db.prepare("UPDATE documents SET status = 'pending' WHERE status = 'processing'")

// 会话
export const insertSession = db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)')
export const listSessions = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC')
export const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
export const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?')
export const deleteSessionMsgs = db.prepare('DELETE FROM chat_messages WHERE session_id = ?')

// 消息
export const insertMsg = db.prepare(
  'INSERT INTO chat_messages (session_id, role, content, meta) VALUES (?, ?, ?, ?)'
)
export const listMsgs = db.prepare(
  'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY seq ASC'
)
