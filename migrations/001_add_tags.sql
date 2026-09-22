-- Add optional tags for grouping assets in the dashboard and API.
-- Idempotent on fresh installs (schema.sql already has the column); safe to
-- re-run only if the column is missing — SQLite has no IF NOT EXISTS for ADD COLUMN
-- before 3.35, so apply once against an existing database:
--
--   npx wrangler d1 execute talkincode-assets --remote -y --file=./migrations/001_add_tags.sql
--   npx wrangler d1 execute talkincode-assets --local  -y --file=./migrations/001_add_tags.sql

ALTER TABLE assets ADD COLUMN tags TEXT;
