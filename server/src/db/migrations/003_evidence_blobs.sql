-- Optional evidence storage inside PostgreSQL (STORAGE_BACKEND=db). Used on hosts without a
-- persistent disk, e.g. Firebase/Cloud Functions. Rows are private and included in DB backups.
CREATE TABLE evidence_blobs (
  storage_key   TEXT PRIMARY KEY,
  data          BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
