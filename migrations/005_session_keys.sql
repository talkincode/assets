-- Signed-URL secret for MCP upload sessions: lets the uploader complete a
-- session without holding the creator's OAuth token (different execution
-- contexts). Single use, expires with the session. Fresh installs already
-- have this column in schema.sql. Apply once on existing DBs:
--
--   npm run db:migrate:session-keys
--   npm run db:migrate:session-keys:local

ALTER TABLE upload_sessions ADD COLUMN upload_key TEXT;
