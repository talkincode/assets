-- MCP upload sessions for the L0 MCP server. Fresh installs already have
-- this in schema.sql. Apply once on existing DBs:
--
--   npm run db:migrate:upload-sessions
--   npm run db:migrate:upload-sessions:local

CREATE TABLE IF NOT EXISTS upload_sessions (
  id              TEXT PRIMARY KEY,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_expected   INTEGER,
  note            TEXT,
  tags            TEXT,
  project_id      TEXT,
  link_expires_at INTEGER,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  asset_hash      TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires ON upload_sessions (expires_at);
