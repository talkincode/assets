-- Share-links model: assets keep bytes forever (until manual delete);
-- public URLs are independent link rows with their own expiry.
-- Dev-stage migration: existing rows are dropped. Prefer `npm run db:init`
-- on a fresh database when possible.

DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS assets;

CREATE TABLE assets (
  hash            TEXT PRIMARY KEY,
  object_key      TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size            INTEGER NOT NULL DEFAULT 0,
  etag            TEXT,
  note            TEXT,
  tags            TEXT,
  key_id          TEXT,
  uploader_ip     TEXT,
  uploader_agent  TEXT,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  delete_reason   TEXT,
  purged_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_assets_created ON assets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_live    ON assets (deleted_at, created_at DESC);

CREATE TABLE links (
  hash            TEXT PRIMARY KEY,
  asset_hash      TEXT NOT NULL,
  expires_at      INTEGER,
  label           TEXT,
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  revoked_at      INTEGER,
  downloads       INTEGER NOT NULL DEFAULT 0,
  last_access_at  INTEGER,
  FOREIGN KEY (asset_hash) REFERENCES assets(hash)
);

CREATE INDEX IF NOT EXISTS idx_links_asset ON links (asset_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_live  ON links (revoked_at, expires_at);
