import type postgres from 'postgres'

type Sql = ReturnType<typeof postgres>

// All tables are prefixed `bread_` so the store can share a database with an
// application's own schema without collisions. Timestamps are BIGINT epoch ms.
// `embedding` columns are pgvector and stay NULL unless an embed fn is wired.
const TABLES = `
CREATE TABLE IF NOT EXISTS bread_sessions (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  agent_id TEXT,
  tags JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS bread_session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES bread_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content JSONB NOT NULL,
  timestamp BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_sm_session ON bread_session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_bread_s_updated ON bread_sessions(updated_at);

CREATE TABLE IF NOT EXISTS bread_checkpoints (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES bread_sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  schema JSONB NOT NULL,
  prompt TEXT,
  skill TEXT,
  parent JSONB,
  pending JSONB,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bread_loops (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pool JSONB NOT NULL,
  pipeline JSONB NOT NULL,
  max_iterations INTEGER NOT NULL,
  status TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 0,
  result JSONB,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_bread_loops_session ON bread_loops(session_id);
CREATE INDEX IF NOT EXISTS idx_bread_loops_agent ON bread_loops(agent_id);
CREATE TABLE IF NOT EXISTS bread_loop_iterations (
  id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL REFERENCES bread_loops(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  input JSONB,
  output JSONB,
  started_at BIGINT NOT NULL,
  completed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_loop_iter_loop ON bread_loop_iterations(loop_id);

CREATE TABLE IF NOT EXISTS bread_kg_nodes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  label TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bread_kg_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES bread_kg_nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES bread_kg_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_kg_nodes_agent ON bread_kg_nodes(agent_id);
CREATE INDEX IF NOT EXISTS idx_bread_kg_edges_from ON bread_kg_edges(from_id);

CREATE TABLE IF NOT EXISTS bread_documents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_documents_agent ON bread_documents(agent_id);

CREATE TABLE IF NOT EXISTS bread_crumbs (
  run_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  session_id TEXT REFERENCES bread_sessions(id) ON DELETE CASCADE,
  agent_id TEXT,
  type TEXT NOT NULL,
  crumb JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_bread_crumbs_session ON bread_crumbs(session_id);

CREATE TABLE IF NOT EXISTS bread_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  run_id TEXT,
  model JSONB NOT NULL,
  input JSONB,
  output JSONB,
  status TEXT NOT NULL,
  usage JSONB,
  error TEXT,
  duration_ms INTEGER,
  created_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_bread_task_runs_task ON bread_task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_bread_task_runs_session ON bread_task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_bread_task_runs_agent ON bread_task_runs(agent_id);
`

// Add the pgvector embedding columns. Run only when an embed fn is configured;
// requires the `vector` extension (enabled here, needs a superuser/owner role).
const VECTOR = `
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE bread_kg_nodes ADD COLUMN IF NOT EXISTS embedding vector;
ALTER TABLE bread_documents ADD COLUMN IF NOT EXISTS embedding vector;
`

// Additive columns for tables that predate them — safe to re-run.
const COLUMNS = `
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS skill TEXT;
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS parent JSONB;
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS pending JSONB;
`

export async function migrate(sql: Sql, withVectors: boolean): Promise<void> {
  if (withVectors) await sql.unsafe(VECTOR)
  await sql.unsafe(TABLES)
  await sql.unsafe(COLUMNS)
}
