-- D1 tables for the relay (apply with: wrangler d1 execute caw-telemetry --remote --file schema/d1.sql).
-- Nothing here holds an IP address: senders are salted hashes, and each day's salt is deleted the next day.

CREATE TABLE IF NOT EXISTS reports (
  receipt     TEXT PRIMARY KEY,        -- 32 hex, made on the device; also the published file's name
  day         TEXT NOT NULL,           -- the UTC day the report covers
  delete_hash TEXT NOT NULL,           -- SHA-256 of the device's delete key; never published
  json        TEXT,                    -- the report as published; cleared after 35 days (the file stays in data/)
  received    TEXT NOT NULL,
  committed   INTEGER NOT NULL DEFAULT 0,  -- published to data/
  deleted     INTEGER NOT NULL DEFAULT 0,  -- the device asked to delete it
  removed     INTEGER NOT NULL DEFAULT 0   -- its file was removed from data/
);
CREATE INDEX IF NOT EXISTS reports_pending ON reports (committed, deleted, removed);
CREATE INDEX IF NOT EXISTS reports_day ON reports (day);

CREATE TABLE IF NOT EXISTS contacts (     -- private: feedback senders' optional emails, kept 180 days
  issue    INTEGER NOT NULL,
  contact  TEXT NOT NULL,
  received TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_queue (  -- feedback waiting for GitHub to accept it
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  json     TEXT NOT NULL,
  received TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS senders (day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, name));
CREATE TABLE IF NOT EXISTS quota (day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, name));
