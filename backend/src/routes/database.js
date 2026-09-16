/**
 * Backup and restore.
 *
 *   GET  /api/database/my-data — the caller's own websites and scan history as
 *                                JSON. Readable in any text editor.
 *   GET  /api/database/export  — the whole SQLite file, minus credentials.
 *   POST /api/database/import  — replace ALL data with an uploaded backup.
 *                                Irreversible.
 *
 * Access: `requireAuth` (mounted in server.js), which with the shared login is
 * the operator gate — there is exactly one account, and it is the one that owns
 * every row. An earlier version of this file claimed a superadmin check; that
 * middleware was removed with the per-user accounts, and `users.role` is left at
 * its default by every write path, so a role check here would gate on a column
 * nothing ever sets.
 *
 * Restore runs in-process — the long-lived `db` connection is reused, so no
 * server restart is needed. The uploaded file is validated, the current data is
 * saved to a `.bak-<timestamp>` file, then every table is wiped and re-loaded
 * from the uploaded database inside a single transaction.
 *
 * A backup carries data, not identity. Credentials live in `AUTH_USERNAME` /
 * `AUTH_PASSWORD` in the environment, never in the database, so the `users` row
 * is only an owner to hang `owner_id` on. That is why restore re-owns everything
 * to the importing account instead of trusting the ids in the file: a backup
 * then restores onto any instance, whatever its login happens to be.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const db = require('../db');
const { dbPath, Database } = require('../db');
const websiteRepo = require('../repositories/websiteRepo');
const scanRepo = require('../repositories/scanRepo');

const router = express.Router();

/**
 * Tables restored from a backup, children before parents so the deletes work.
 * Inserts run in the reverse order.
 *
 * `schedules` is here because leaving it out meant a restore wiped every
 * schedule and the scheduler woke up with nothing to run — the backup looked
 * like it had worked right up until the next scan never happened. It has no
 * foreign key to `websites` by design (see migrations.js), but it does reference
 * `users`, so it re-owns with the rest.
 *
 * `users` is deliberately absent: the local account stays put. So is
 * `schema_migrations`, which has to describe the local schema rather than
 * whatever the backup was taken from.
 */
const RESTORE_TABLES = ['scan_results', 'snapshots', 'schedules', 'websites'];

/** Tables whose `owner_id` is rewritten to the importing account. */
const OWNED_TABLES = ['websites', 'scan_results', 'schedules'];

/**
 * Columns blanked out of an exported copy.
 *
 * `password_hash` is inert — nothing verifies against it — but a backup file is
 * something you hand to someone, and handing over a hash is not on.
 */
const SECRET_COLUMNS = ['password_hash', 'verify_token', 'reset_token'];

/**
 * Tables emptied out of an exported copy.
 *
 * Billing was removed; these are still created by migrations but never written
 * to. Exporting them would ship rows from a subscription era that no longer
 * applies.
 */
const DEAD_TABLES = ['payments', 'subscriptions', 'usage_counters', 'webhook_events', 'plans'];

// Accept a raw SQLite file in memory (much larger than a spreadsheet).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(db|sqlite|sqlite3)$/i)) {
      cb(null, true);
    } else {
      // Without a status the global error handler reports this as a 500, which
      // reads as "the server broke" rather than "that is the wrong file".
      const err = new Error('Only SQLite database files (.db, .sqlite) are accepted');
      err.status = 400;
      cb(err);
    }
  },
});

// Column names of a table on a given connection.
function tableColumns(conn, table) {
  return conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/** Does this connection have this table at all? */
function hasTable(conn, table) {
  return tableColumns(conn, table).length > 0;
}

/** A scratch path in the system temp dir, unique per call. */
function tempDbPath(label) {
  return path.join(os.tmpdir(), `monitor-${label}-${crypto.randomBytes(6).toString('hex')}.db`);
}

// ---------------------------------------------------------------------------
// GET /api/database/my-data — the caller's own data, as JSON
// ---------------------------------------------------------------------------
router.get('/my-data', (req, res) => {
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
// GET /api/database/export — the full database file, credentials removed
//
// `db.serialize()` is the WAL-safe way to snapshot this connection: the main
// file on disk can be almost empty while the -wal sibling holds everything, so
// copying the file itself would export next to nothing.
// ---------------------------------------------------------------------------
router.get('/export', (req, res, next) => {
  // The scrubbing has to happen on a copy — this is the live database.
  const tmpPath = tempDbPath('export');

  try {
    fs.writeFileSync(tmpPath, db.serialize());

    let buffer;
    const copy = new Database(tmpPath);
    try {
      const userColumns = tableColumns(copy, 'users');
      const blanks = SECRET_COLUMNS.filter((c) => userColumns.includes(c))
        .map((c) => (c === 'password_hash' ? `${c} = ''` : `${c} = NULL`))
        .join(', ');

      // The rows stay — id, email and role keep the file a valid, readable
      // database that opens in any SQLite tool. Only the secrets go.
      if (blanks) copy.exec(`UPDATE users SET ${blanks}`);

      for (const table of DEAD_TABLES) {
        if (hasTable(copy, table)) copy.exec(`DELETE FROM ${table}`);
      }

      buffer = copy.serialize();
    } finally {
      copy.close();
    }

    const filename = `monitor-backup-${new Date().toISOString().slice(0, 10)}.db`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/database/import — replace all data with an uploaded backup
//
// This wipes every website, snapshot, scan and schedule on the instance, so it
// demands an explicit `?confirm=replace-all-data`. A mis-click here is not
// recoverable from the app — only from the `.bak-` file written below.
// ---------------------------------------------------------------------------
router.post('/import', upload.single('file'), (req, res) => {
  if (req.query.confirm !== 'replace-all-data') {
    return res.status(400).json({
      error:
        'This replaces every website, scan and schedule on this instance. ' +
        'Re-send with ?confirm=replace-all-data to proceed.',
      code: 'CONFIRMATION_REQUIRED',
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Write the upload to a temp file so SQLite can open it.
  const tmpPath = tempDbPath('restore');

  try {
    fs.writeFileSync(tmpPath, req.file.buffer);

    // 1. Validate the uploaded file is a sound SQLite DB with our tables.
    const srcColumns = {};
    let duplicateUrls = [];
    {
      let src;
      try {
        src = new Database(tmpPath, { readonly: true });
        const integrity = src.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') {
          throw new Error('integrity check failed');
        }

        for (const table of RESTORE_TABLES) {
          const cols = tableColumns(src, table);
          // `schedules` postdates some backups; an older file without it is
          // still restorable, it just has no schedules to bring.
          if (cols.length === 0 && table !== 'schedules') {
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

        // Every row is about to be re-owned to one account, and websites are
        // UNIQUE(owner_id, url). A backup holding the same URL under two owners
        // cannot survive that collapse, so say which URLs rather than dropping
        // rows on the floor.
        duplicateUrls = src
          .prepare('SELECT url FROM websites GROUP BY url HAVING COUNT(*) > 1 ORDER BY url LIMIT 5')
          .all()
          .map((r) => r.url);
      } finally {
        if (src) src.close();
      }
    }

    if (duplicateUrls.length > 0) {
      throw new Error(
        'this backup holds the same URL under more than one account, which ' +
          'cannot be merged into a single account: ' +
          duplicateUrls.join(', ')
      );
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

        // Insert parents before children (reverse of the delete order). Row ids
        // carry over from the backup, which is what keeps the child foreign keys
        // pointing at the right parents.
        for (const table of [...RESTORE_TABLES].reverse()) {
          counts[table] = 0;
          if (srcColumns[table].length === 0) continue;

          const shared = tableColumns(db, table).filter((c) => srcColumns[table].includes(c));
          const colList = shared.join(', ');
          db.exec(`INSERT INTO ${table} (${colList}) SELECT ${colList} FROM src.${table}`);
          counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        }

        // Re-own. The ids in the file belong to whatever instance produced it;
        // this one has its own account, and without this every restored row
        // belongs to a user that may not exist here — which renders as an empty
        // dashboard with no error at all.
        for (const table of OWNED_TABLES) {
          if (tableColumns(db, table).includes('owner_id')) {
            db.prepare(`UPDATE ${table} SET owner_id = ?`).run(req.user.userId);
          }
        }

        // Foreign keys were off for the copy, so nothing has checked them. Do it
        // now, inside the transaction, so a backup that does not hang together
        // rolls back instead of landing half-connected.
        const violations = db.pragma('foreign_key_check');
        if (violations.length > 0) {
          const { table, parent } = violations[0];
          throw new Error(
            `restored data does not hang together — ${violations.length} row(s) in ` +
              `"${table}" reference a missing "${parent}"`
          );
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
      schedules: counts.schedules || 0,
    });
  } catch (err) {
    res.status(400).json({ error: `Invalid backup file: ${err.message}` });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

module.exports = router;
