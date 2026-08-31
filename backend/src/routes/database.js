/**
 * Backup and restore.
 *
 *   GET  /api/database/my-data — the caller's own websites and scan history as
 *                                JSON. This is the tenant-facing export.
 *   GET  /api/database/export  — the whole SQLite file. Platform operator only:
 *                                it contains every tenant's data.
 *   POST /api/database/import  — replace ALL data with an uploaded backup.
 *                                Platform operator only, and irreversible for
 *                                every customer on the instance.
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
const { requireSuperadmin } = require('../middleware/auth');
const { requireFeature } = require('../middleware/entitlements');
const websiteRepo = require('../repositories/websiteRepo');
const scanRepo = require('../repositories/scanRepo');

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
// GET /api/database/my-data — the caller's own data, as JSON
// ---------------------------------------------------------------------------
router.get('/my-data', requireFeature('db_backup', 'Data export'), (req, res) => {
  const websites = websiteRepo.listForExport(req.user.userId);
  const { results: scans } = scanRepo.list(req.user.userId, 100_000, 0);

  const payload = {
    exported_at: new Date().toISOString(),
    account: req.user.email,
    websites,
    scans,
  };

  const filename = `my-monitor-data-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(payload, null, 2));
});

// ---------------------------------------------------------------------------
// GET /api/database/export — the full multi-tenant database file
// ---------------------------------------------------------------------------
router.get('/export', requireSuperadmin, (req, res) => {
  const buffer = db.serialize();
  const filename = `monitor-backup-${new Date().toISOString().slice(0, 10)}.db`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// POST /api/database/import — replace all data with an uploaded backup
//
// This wipes every tenant's websites, snapshots and scan history, so it demands
// an explicit `?confirm=replace-all-data` on top of the operator role. A
// mis-click here is not recoverable from the app.
// ---------------------------------------------------------------------------
router.post('/import', requireSuperadmin, upload.single('file'), (req, res) => {
  if (req.query.confirm !== 'replace-all-data') {
    return res.status(400).json({
      error:
        'This replaces every account\'s data on this instance. Re-send with ' +
        '?confirm=replace-all-data to proceed.',
      code: 'CONFIRMATION_REQUIRED',
    });
  }

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

        // A pre-multitenant backup has no owner column; restoring it would
        // produce websites nobody can see (owner_id is NOT NULL).
        if (!srcColumns.websites.includes('owner_id')) {
          throw new Error(
            'this backup predates multi-tenant accounts and cannot be restored ' +
              'directly — restore it on an older build first, then upgrade'
          );
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
