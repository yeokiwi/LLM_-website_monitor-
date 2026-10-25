const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const migrations = require('./migrations');

// An in-memory database is useful for tests; everything else resolves to a file.
const isMemory = process.env.DB_PATH === ':memory:';

const dbPath = isMemory
  ? ':memory:'
  : process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.resolve(__dirname, '../../data/monitor.db');

if (!isMemory) {
  // Ensure the data directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);

if (!isMemory) {
  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
}
db.pragma('foreign_keys = ON');

// The scheduler writes from a background timer while HTTP requests are also
// writing. SQLite allows only one writer at a time, so wait rather than throwing
// SQLITE_BUSY the instant two writes overlap.
db.pragma('busy_timeout = 5000');

migrations.run(db);

module.exports = db;
module.exports.dbPath = dbPath;
module.exports.Database = Database;
module.exports.migrations = migrations;
