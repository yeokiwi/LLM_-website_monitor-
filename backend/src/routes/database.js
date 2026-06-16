/**
 * Database backup / restore
 *
 *   GET  /api/database/export — download the live SQLite DB as a single file
 *                               (websites + snapshots + full scan history).
 *   POST /api/database/import — replace ALL data with an uploaded backup file.
 *
 * Restore is performed in-process (the long-lived `db` connection is reused, so
 * no server restart is needed): the uploaded file is validated, the current
 * data is saved to a `.bak-<timestamp>` file, then every table is wiped and
 * re-loaded from the uploaded database inside a single transaction.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const db = require('../db');
const { dbPath, Database } = require('../db');

const router = express.Router();

// Tables restored from a backup (children before parents on delete).
const RESTORE_TABLES = ['scan_results', 'snapshots', 'websites'];

// Accept a raw SQLite file in memory (much larger than a spreadsheet).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(db|sqlite|sqlite3)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only SQLite database files (.db, .sqlite) are accepted'));
    }
  },
});

// Column names of a table on a given connection.
function tableColumns(conn, table) {
  return conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// ---------------------------------------------------------------------------
// GET /api/database/export — stream a consistent snapshot of the live DB
// ---------------------------------------------------------------------------
router.get('/export', (req, res) => {
  const buffer = db.serialize();
  const filename = `monitor-backup-${new Date().toISOString().slice(0, 10)}.db`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// POST /api/database/import — replace all data with an uploaded backup
// ---------------------------------------------------------------------------
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Write the upload to a temp file so SQLite can open it.
  const tmpPath = path.join(
    os.tmpdir(),
    `monitor-restore-${crypto.randomBytes(6).toString('hex')}.db`
  );

  try {
    fs.writeFileSync(tmpPath, req.file.buffer);

    // 1. Validate the uploaded file is a sound SQLite DB with our tables.
    let srcColumns;
    {
      let src;
      try {
        src = new Database(tmpPath, { readonly: true });
        const integrity = src.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') {
          throw new Error('integrity check failed');
        }
        srcColumns = {};
        for (const table of RESTORE_TABLES) {
          const cols = tableColumns(src, table);
          if (cols.length === 0) {
            throw new Error(`missing table "${table}"`);
          }
          srcColumns[table] = cols;
        }
      } finally {
        if (src) src.close();
      }
    }

    // 2. Back up the current database before overwriting anything.
    const backupPath = `${dbPath}.bak-${Date.now()}`;
    fs.writeFileSync(backupPath, db.serialize());

    // 3. Replace-everything in-process: wipe each table and reload it from the
    //    uploaded DB, copying only columns both schemas share.
    db.exec(`ATTACH DATABASE '${tmpPath.replace(/'/g, "''")}' AS src`);
    db.pragma('foreign_keys = OFF');

    const counts = {};
    try {
      const restore = db.transaction(() => {
        for (const table of RESTORE_TABLES) {
          db.exec(`DELETE FROM ${table}`);
        }
        // Insert parents before children (reverse of the delete order).
        for (const table of [...RESTORE_TABLES].reverse()) {
          const shared = tableColumns(db, table).filter((c) =>
            srcColumns[table].includes(c)
          );
          const colList = shared.join(', ');
          db.exec(
            `INSERT INTO ${table} (${colList}) SELECT ${colList} FROM src.${table}`
          );
          counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        }
      });
      restore();
    } finally {
      db.pragma('foreign_keys = ON');
      db.exec('DETACH DATABASE src');
      db.pragma('wal_checkpoint(TRUNCATE)');
    }

    res.json({
      message: 'Database restored',
      backup: path.basename(backupPath),
      websites: counts.websites || 0,
      snapshots: counts.snapshots || 0,
      scan_results: counts.scan_results || 0,
    });
  } catch (err) {
    res.status(400).json({ error: `Invalid backup file: ${err.message}` });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

module.exports = router;
