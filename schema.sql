-- talkincode-assets schema (D1 / SQLite)
-- Apply with: npm run db:init        (remote)
--             npm run db:init:local  (local dev)

CREATE TABLE IF NOT EXISTS assets (
  -- The public locator. Never reused, never recycled: a hash identifies exactly
  -- one byte stream for its whole life, which is what makes edge caching safe.
  hash            TEXT PRIMARY KEY,
  object_key      TEXT NOT NULL,          -- R2 object key
  filename        TEXT NOT NULL,          -- original name, used as download name
  content_type    TEXT NOT NULL,
  size            INTEGER NOT NULL DEFAULT 0,
  etag            TEXT,
  note            TEXT,
  tags            TEXT,                   -- JSON string array, e.g. ["demo","product"]
  key_id          TEXT,                   -- upload key that created it (NULL = dashboard)
  uploader_ip     TEXT,
  uploader_agent  TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,                -- NULL = never expires
  deleted_at      INTEGER,                -- soft delete tombstone
  delete_reason   TEXT,                   -- 'manual' | 'expired' | 'replaced'
  purged_at       INTEGER,                -- set when the R2 bytes were removed
  downloads       INTEGER NOT NULL DEFAULT 0,
  last_access_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_assets_created ON assets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_expires ON assets (expires_at);
CREATE INDEX IF NOT EXISTS idx_assets_live    ON assets (deleted_at, created_at DESC);

-- Upload keys. Only the SHA-256 of the secret is stored; the cleartext is shown
-- exactly once, at creation time.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,      -- sha256 hex of the secret
  prefix       TEXT NOT NULL,             -- display only, e.g. "ak_9f3c…"
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  last_used_at INTEGER,
  last_used_ip TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);

-- Dashboard/API mutations. Kept small on purpose; it answers "who deleted this".
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,                  -- email, or "key:<id>", or "system"
  action  TEXT NOT NULL,
  target  TEXT,
  ip      TEXT,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);

-- Sources that kept guessing hashes. The live decision lives in the AbuseGuard
-- durable object; this table exists so the dashboard can list and unblock them.
CREATE TABLE IF NOT EXISTS blocked_sources (
  source        TEXT PRIMARY KEY,         -- normalised network, e.g. 203.0.113.0/24
  strikes       INTEGER NOT NULL DEFAULT 0,
  misses        INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  detail        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (k, v) VALUES
  ('default_ttl_days', '7'),
  ('max_upload_bytes', '104857600'),
  ('trash_retention_days', '7');
