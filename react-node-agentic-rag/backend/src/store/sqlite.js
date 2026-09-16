// ============================================================================
// SQLite 存储层（better-sqlite3，同步 API）：建库建表 + 预编译语句导出
// ----------------------------------------------------------------------------
// 三张表：
//   documents     : 文档元数据 + 摄取状态机（pending/processing/ready/failed）
//   sessions      : 问答会话
//   chat_messages : 会话消息（meta 列存 JSON：来源/步骤/用量）
// 惯例：
//   - 启动时 CREATE TABLE IF NOT EXISTS + 轻量列迁移（ALTER 失败即已存在，忽略）；
//   - 所有语句 module 加载时预编译一次，运行期复用（同步调用，性能好）；
//   - WAL 模式：读写不互斥，适合"worker 后台写 + HTTP 读"的并发形态。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from '../config.js'

// 确保数据目录存在，再打开数据库
fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true })
const db = new Database(config.sqlitePath)
// WAL（Write-Ahead Logging）：写不阻塞读，worker 摄取时前端列表仍可查询
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,        -- UUID
  username   TEXT UNIQUE NOT NULL,    -- 登录名（唯一）
  pass_hash  TEXT NOT NULL,           -- scrypt 哈希（salt:hash），不存明文
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,        -- UUID，同时是 Qdrant 里 payload.docId
  filename   TEXT NOT NULL,           -- 原始文件名（展示用）
  size       INTEGER NOT NULL,        -- 文件字节数
  hash       TEXT UNIQUE NOT NULL,    -- SHA-256，内容级去重（UNIQUE 由数据库兜底）
  chunks     INTEGER NOT NULL DEFAULT 0, -- 摄取完成后的块数
  status     TEXT NOT NULL DEFAULT 'ready', -- pending/processing/ready/failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,        -- UUID
  title      TEXT NOT NULL,           -- 首问前 24 字，列表展示用
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增序号，回放排序依据
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,           -- user | assistant
  content    TEXT NOT NULL,
  meta       TEXT, -- JSON: {sources, usage, steps}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// M5 数据归属：会话/文档挂用户（老库默认 ''，即不可见——历史数据仅本地开发遗留，不做回填）
try { db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT ''") } catch { }
try { db.exec("ALTER TABLE documents ADD COLUMN user_id TEXT NOT NULL DEFAULT ''") } catch { }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)') } catch { }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id)') } catch { }

// 历史查询按 session 过滤，无索引会全表扫
db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)')

// M10 RBAC：用户角色/部门 + 文档密级/标签 + 显式授权表
// 密级三级：public（全体登录用户）/ dept（同 owner 部门）/ private（仅 owner + 显式授权）
// 存量文档 DEFAULT 'public' 保持升级前可见性；新上传默认 private 由 API 层决定
// 注意：必须放在所有预编译语句之前（语句引用这些新列）
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'") } catch { }
try { db.exec("ALTER TABLE users ADD COLUMN dept TEXT NOT NULL DEFAULT ''") } catch { }
try { db.exec("ALTER TABLE documents ADD COLUMN classification TEXT NOT NULL DEFAULT 'public'") } catch { }
try { db.exec("ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'") } catch { }
db.exec(`
CREATE TABLE IF NOT EXISTS doc_grants (
  doc_id  TEXT NOT NULL,             -- documents.id
  user_id TEXT NOT NULL,             -- users.id（被授权人）
  PRIMARY KEY (doc_id, user_id)
);
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_grants_user ON doc_grants(user_id)') } catch { }

// ---- users：登录账号（AUTH_USERS 预置播种；M10 起带角色/部门）----
// 播种语义：密码只写一次（已存在用户不覆盖，改密码需清表）；
// role/dept 每次启动按 env 刷新（env 为准，admin 接口的临时修改在下次重启后被 env 覆盖）
export const upsertUser = db.prepare(`
  INSERT INTO users (id, username, pass_hash, role, dept) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET role = excluded.role, dept = excluded.dept
`)
export const getUserByName = db.prepare('SELECT * FROM users WHERE username = ?')
export const getUserById = db.prepare('SELECT * FROM users WHERE id = ?')
export const listUsers = db.prepare('SELECT id, username, role, dept, created_at FROM users ORDER BY created_at')
export const updateUserMeta = db.prepare('UPDATE users SET role = ?, dept = ? WHERE id = ?')
// 历史文档归属回填：M5 升级前入库的文档 user_id=''（无主），统一划给首个预置用户管理
export const backfillDocsToUser = db.prepare("UPDATE documents SET user_id = ? WHERE user_id = ''")

// 老库列迁移（已存在则忽略）：早期版本没有 error/path 两列
try { db.exec('ALTER TABLE documents ADD COLUMN error TEXT') } catch { }
try { db.exec('ALTER TABLE documents ADD COLUMN path TEXT') } catch { }
// M4 记忆压缩：会话级滚动摘要 + seq 水位断点（删除免疫：seq 单调不回移，数量断点在删消息场景会错位）
try { db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT NOT NULL DEFAULT \'\'') } catch { }
try { db.exec('ALTER TABLE sessions ADD COLUMN summarized_seq INTEGER NOT NULL DEFAULT 0') } catch { }
try { db.exec('ALTER TABLE sessions DROP COLUMN summarized_count') } catch { } // 旧数量断点，已被 seq 取代

// ---- documents：摄取队列 + 文档管理（M10 起带密级/标签/授权）----
export const insertDoc = db.prepare(
  'INSERT INTO documents (id, filename, size, hash, chunks, status, error, path, user_id, classification, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
)
// 可见列表：本人文档 ∪ public ∪ 同部门(dept) ∪ 被显式授权；owner_name 供 admin 视图展示归属
export const listDocsVisible = db.prepare(`
  SELECT d.*, u.username AS owner_name, u.dept AS owner_dept
  FROM documents d LEFT JOIN users u ON u.id = d.user_id
  WHERE d.user_id = ?
     OR d.classification = 'public'
     OR (d.classification = 'dept' AND ? != '' AND u.dept = ?)
     OR d.id IN (SELECT doc_id FROM doc_grants WHERE user_id = ?)
  ORDER BY d.created_at DESC
`)
export const listDocsAll = db.prepare(`
  SELECT d.*, u.username AS owner_name, u.dept AS owner_dept
  FROM documents d LEFT JOIN users u ON u.id = d.user_id
  ORDER BY d.created_at DESC
`)
export const updateDocMeta = db.prepare('UPDATE documents SET classification = ?, tags = ? WHERE id = ?')
export const getDoc = db.prepare('SELECT * FROM documents WHERE id = ?')
export const getDocByHash = db.prepare('SELECT * FROM documents WHERE hash = ?')
export const deleteDocRow = db.prepare('DELETE FROM documents WHERE id = ?')
// 状态更新：(status, error, id)；worker 占坑传 ('processing', null)，失败传 ('failed', errMsg)
export const setDocStatus = db.prepare('UPDATE documents SET status = ?, error = ? WHERE id = ?')
export const setDocChunks = db.prepare('UPDATE documents SET chunks = ? WHERE id = ?')
// 摄取队列：取最老的一条待处理；重启时把卡在 processing 的重置回 pending（宕机恢复）
export const nextPendingDoc = db.prepare(
  "SELECT * FROM documents WHERE status IN ('pending','processing') ORDER BY created_at ASC LIMIT 1"
)
export const resetProcessing = db.prepare("UPDATE documents SET status = 'pending' WHERE status = 'processing'")

// ---- doc_grants：显式授权（P1：private 文档可单独授权给指定用户）----
export const listGrantsByDoc = db.prepare('SELECT user_id FROM doc_grants WHERE doc_id = ?')
export const listGrantsForUser = db.prepare('SELECT doc_id FROM doc_grants WHERE user_id = ?')
export const grantDoc = db.prepare('INSERT OR IGNORE INTO doc_grants (doc_id, user_id) VALUES (?, ?)')
export const revokeGrant = db.prepare('DELETE FROM doc_grants WHERE doc_id = ? AND user_id = ?')
export const deleteGrantsByDoc = db.prepare('DELETE FROM doc_grants WHERE doc_id = ?')

// ---- sessions：会话管理（M5 起按 user_id 隔离）----
export const insertSession = db.prepare('INSERT INTO sessions (id, title, user_id) VALUES (?, ?, ?)')
export const listSessionsByUser = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
export const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
export const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?')
export const deleteSessionMsgs = db.prepare('DELETE FROM chat_messages WHERE session_id = ?')

// ---- chat_messages：消息读写 ----
export const insertMsg = db.prepare(
  'INSERT INTO chat_messages (session_id, role, content, meta) VALUES (?, ?, ?, ?)'
)
// 按 seq 升序：保证多轮对话顺序正确（slice(-20) 取最近窗口）
export const listMsgs = db.prepare(
  'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY seq ASC'
)
// 记忆回放：取断点之后的所有消息（= 固定窗口 + 尚未压缩的真空区），零丢失且上界可控
export const listAfterSeq = db.prepare(
  'SELECT * FROM chat_messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
)
// 窗口起点：最近 N 条里最早一条的 seq（压缩边界：断点之前的都要进摘要）
export const windowStartSeq = db.prepare(
  'SELECT MIN(seq) AS s FROM (SELECT seq FROM chat_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?)'
)
// 待压缩数：断点与窗口起点之间的消息条数（攒批判断依据）
export const countPending = db.prepare(
  'SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND seq > ? AND seq <= ?'
)
// 取待压缩的早期消息（断点 → 窗口起点]，用于增量摘要
export const listPending = db.prepare(
  'SELECT * FROM chat_messages WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC'
)

// ---- sessions：记忆压缩（滚动摘要，seq 水位断点）----
export const getMemory = db.prepare('SELECT summary, summarized_seq FROM sessions WHERE id = ?')
export const updateMemory = db.prepare(
  'UPDATE sessions SET summary = ?, summarized_seq = ? WHERE id = ?'
)
