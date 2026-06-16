const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, '../../data/monitor.db');

// Ensure the data directory exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS websites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT    NOT NULL UNIQUE,
    name       TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active  INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id   INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
    content_text TEXT    NOT NULL,
    content_hash TEXT    NOT NULL,
    scraped_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_website_scraped
    ON snapshots(website_id, scraped_at);

  CREATE TABLE IF NOT EXISTS scan_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id      INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
    period_days     INTEGER NOT NULL,
    old_snapshot_id INTEGER REFERENCES snapshots(id),
    new_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    diff_summary    TEXT,
    llm_summary     TEXT,
    status          TEXT DEFAULT 'pending',
    error_message   TEXT,
    scanned_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_scan_results_website
    ON scan_results(website_id, scanned_at);
`);

// Additive migrations for SRMS metadata columns. SQLite throws on
// duplicate ADD COLUMN, so each is wrapped — safe to re-run on existing DBs.
for (const col of ['domain', 'srms_owner', 'srms', 'remark']) {
  try { db.exec(`ALTER TABLE websites ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
}

// User-entered remark/comment on an individual scan result.
try { db.exec(`ALTER TABLE scan_results ADD COLUMN remark TEXT`); } catch { /* already exists */ }

// Per-website scraper selection flags. Default both engines on.
for (const col of ['use_firecrawl', 'use_brave', 'use_serper']) {
  try { db.exec(`ALTER TABLE websites ADD COLUMN ${col} INTEGER DEFAULT 1`); } catch { /* already exists */ }
}

// Provider-scoped snapshots so each engine diffs against its own history.
try { db.exec(`ALTER TABLE snapshots ADD COLUMN provider TEXT DEFAULT 'default'`); } catch { /* already exists */ }
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_website_provider_scraped
             ON snapshots(website_id, provider, scraped_at)`);
} catch { /* already exists */ }

module.exports = db;
