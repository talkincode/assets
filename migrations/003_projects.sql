-- Projects: group assets for dashboard nav and CLI --project <slug> search.
-- Fresh installs already have this in schema.sql. Apply once on existing DBs:
--
--   npm run db:migrate:projects
--   npm run db:migrate:projects:local

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  archived_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects (slug);

-- SQLite has no IF NOT EXISTS for ADD COLUMN on older builds; apply once.
ALTER TABLE assets ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_assets_project ON assets (project_id, created_at DESC);
