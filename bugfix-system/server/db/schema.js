import { q } from './pg.js';

export async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      rel_path TEXT NOT NULL,
      test_cmd TEXT,
      install_cmd TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS bugs (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'P2',
      status TEXT NOT NULL DEFAULT 'submitted',
      related_group TEXT,
      fail_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS bug_attachments (
      id SERIAL PRIMARY KEY,
      bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      worktree_path TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      error TEXT,
      report JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS batch_bugs (
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      bug_id INTEGER NOT NULL REFERENCES bugs(id),
      PRIMARY KEY (batch_id, bug_id)
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS fixes (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      bug_id INTEGER NOT NULL REFERENCES bugs(id),
      commit_sha TEXT,
      commit_message TEXT,
      diff TEXT,
      fixed_files JSONB,
      root_cause TEXT,
      summary TEXT,
      verify TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS traces (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}
