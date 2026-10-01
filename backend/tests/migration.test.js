/**
 * The ownership migration.
 *
 * This is the only destructive schema change in the codebase: SQLite cannot
 * drop the global `UNIQUE(url)` constraint, so `websites` is rebuilt and
 * copied. It runs once, against a real deployment's data, and there is no undo
 * beyond the file backup — so it is worth testing against a database shaped
 * like the one it will actually meet.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const Database = require('better-sqlite3');

const { resetModules, as } = require('./helpers');

/** Build a database with the original single-tenant schema and some data. */
function createLegacyDatabase() {
  const dbPath = path.join(
    os.tmpdir(),
    `wm-legacy-${crypto.randomBytes(8).toString('hex')}.db`
  );

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE websites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      url        TEXT    NOT NULL UNIQUE,
      name       TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active  INTEGER DEFAULT 1
    );
    CREATE TABLE snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id   INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
      content_text TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      scraped_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE scan_results (
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
  `);

  // A partially-upgraded deployment: some additive columns exist, some do not.
  db.exec(`ALTER TABLE websites ADD COLUMN domain TEXT`);
  db.exec(`ALTER TABLE websites ADD COLUMN srms_owner TEXT`);
  db.exec(`ALTER TABLE snapshots ADD COLUMN provider TEXT DEFAULT 'default'`);

  const insertSite = db.prepare(
    'INSERT INTO websites (url, name, domain, srms_owner, is_active) VALUES (?, ?, ?, ?, ?)'
  );
  const insertSnapshot = db.prepare(
    'INSERT INTO snapshots (website_id, content_text, content_hash, provider) VALUES (?, ?, ?, ?)'
  );
  const insertScan = db.prepare(
    `INSERT INTO scan_results (website_id, period_days, old_snapshot_id, new_snapshot_id,
                               diff_summary, llm_summary, status)
     VALUES (?, 30, ?, ?, ?, ?, ?)`
  );

  for (let i = 1; i <= 7; i++) {
    const site = insertSite.run(
      `https://legacy-${i}.example.com`,
      `Legacy site ${i}`,
      `legacy-${i}.example.com`,
      `Owner ${i}`,
      i === 7 ? 0 : 1 // one soft-deleted site
    );
    const older = insertSnapshot.run(site.lastInsertRowid, `content ${i}`, `hash-${i}-a`, 'brave');
    const newer = insertSnapshot.run(site.lastInsertRowid, `content ${i} v2`, `hash-${i}-b`, 'brave');

    insertScan.run(
      site.lastInsertRowid,
      older.lastInsertRowid,
      newer.lastInsertRowid,
      '+3/-1',
      `Report for legacy site ${i}`,
      'completed'
    );
  }

  db.close();
  return dbPath;
}

function cleanupDatabase(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${base}.bak-`)) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
  }
}

describe('ownership migration', () => {
  let dbPath;
  let app;
  let db;

  beforeAll(() => {
    dbPath = createLegacyDatabase();

    Object.assign(process.env, {
      NODE_ENV: 'test',
      DB_PATH: dbPath,
      JWT_SECRET: 'migration-test-secret',
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'test-admin-password',
      DISABLE_RATE_LIMIT: '1',
      ENABLE_SCHEDULER: 'false',
    });

    resetModules();
    app = require('../src/server'); // boot runs the migration
    db = require('../src/db');
  });

  afterAll(() => {
    try { db.close(); } catch { /* already closed */ }
    cleanupDatabase(dbPath);
    resetModules();
  });

  it('preserves every row', () => {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM websites) w,
                (SELECT COUNT(*) FROM snapshots) s,
                (SELECT COUNT(*) FROM scan_results) r`
      )
      .get();

    expect(counts.w).toBe(7);
    expect(counts.s).toBe(14);
    expect(counts.r).toBe(7);
  });

  it('keeps the soft-deleted website soft-deleted', () => {
    const active = db.prepare('SELECT COUNT(*) AS n FROM websites WHERE is_active = 1').get();
    expect(active.n).toBe(6);
  });

  it('assigns everything to the seeded account', () => {
    const owner = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();
    expect(owner).toBeTruthy();

    const unowned = db
      .prepare('SELECT COUNT(*) AS n FROM websites WHERE owner_id IS NULL OR owner_id != ?')
      .get(owner.id);
    expect(unowned.n).toBe(0);

    const unownedScans = db
      .prepare('SELECT COUNT(*) AS n FROM scan_results WHERE owner_id IS NULL')
      .get();
    expect(unownedScans.n).toBe(0);
  });

  it('preserves row ids so snapshot and scan references stay valid', () => {
    const dangling = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM snapshots sn
                  WHERE NOT EXISTS (SELECT 1 FROM websites w WHERE w.id = sn.website_id)) sn,
                (SELECT COUNT(*) FROM scan_results sr
                  WHERE NOT EXISTS (SELECT 1 FROM websites w WHERE w.id = sr.website_id)) sr`
      )
      .get();

    expect(dangling.sn).toBe(0);
    expect(dangling.sr).toBe(0);
  });

  it('carries over the columns the legacy database had', () => {
    const site = db
      .prepare('SELECT * FROM websites WHERE url = ?')
      .get('https://legacy-3.example.com');

    expect(site.name).toBe('Legacy site 3');
    expect(site.domain).toBe('legacy-3.example.com');
    expect(site.srms_owner).toBe('Owner 3');
  });

  it('defaults the columns the legacy database lacked', () => {
    const site = db
      .prepare('SELECT * FROM websites WHERE url = ?')
      .get('https://legacy-3.example.com');

    expect(site.use_firecrawl).toBe(1);
    expect(site.use_brave).toBe(1);
    expect(site.use_serper).toBe(1);
    expect(site.srms).toBeNull();
  });

  it('replaces the global url constraint with a per-owner one', () => {
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'websites'")
      .get();

    expect(sql).not.toMatch(/url\s+TEXT\s+NOT NULL UNIQUE/i);
    expect(sql).toMatch(/UNIQUE\(owner_id,\s*url\)/i);
  });

  it('leaves the database sound with foreign keys back on', () => {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('takes a file backup before rebuilding', () => {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`));

    expect(backups.length).toBeGreaterThan(0);
  });

  it('is a no-op on a second run', () => {
    const { migrations } = require('../src/db');
    const owner = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();

    expect(migrations.backfillOwnership(db, owner.id)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM websites').get().n).toBe(7);
  });

  it('serves the inherited data over the API', async () => {
    const session = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'test-admin-password' });

    const websites = await as(request(app).get('/api/websites'), session.body.token);
    expect(websites.body).toHaveLength(6);
    expect(websites.body.every((w) => w.snapshot_count === 2)).toBe(true);

    const scans = await as(request(app).get('/api/scans?limit=100'), session.body.token);
    expect(scans.body.total).toBe(7);
    expect(scans.body.results[0].llm_summary).toContain('Report for legacy site');
  });

  it('leaves group membership pointing at no dropped table', () => {
    // The group tables are created before this rebuild runs, and the rebuild
    // renames `websites` to `websites_legacy` and drops it. SQLite repoints a
    // foreign key on rename, so a membership FK to `websites` would be left
    // referencing a table that no longer exists — every insert would then fail
    // with "no such table". Membership deliberately has no such key.
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'website_group_members'")
      .get();

    expect(sql).not.toMatch(/websites_legacy/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('leaves no table referencing the dropped websites_legacy', () => {
    // The rebuild renames `websites` and then drops it. SQLite repoints every
    // child's foreign key on a rename, so without legacy_alter_table the
    // children of `websites` ended up keyed to a table that no longer exists.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);

    for (const table of tables) {
      const targets = db.prepare(`PRAGMA foreign_key_list("${table}")`).all().map((fk) => fk.table);
      expect(targets, table).not.toContain('websites_legacy');
    }
  });

  it('needed no repair — the upgrade itself kept the keys intact', () => {
    // Boot runs the repair straight after this upgrade, so the checks above
    // would pass even if the upgrade broke the keys and the repair mended them.
    // No repair backup means the upgrade never broke them.
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const repairs = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-pre-reference-repair-`));
    expect(repairs).toEqual([]);
  });

  it('keeps child keys on `websites` when run directly, without the boot-time repair', () => {
    const file = createLegacyDatabase();
    try {
      const migrations = require('../src/db/migrations');
      const conn = new Database(file);
      conn.pragma('foreign_keys = ON');
      migrations.run(conn);
      const owner = conn
        .prepare(`INSERT INTO users (email, password_hash) VALUES ('admin@local', 'x')`)
        .run().lastInsertRowid;

      migrations.backfillOwnership(conn, owner);

      expect(migrations.tablesReferencingLegacyWebsites(conn)).toEqual([]);
      expect(conn.pragma('foreign_key_check')).toEqual([]);
      conn.close();
    } finally {
      cleanupDatabase(file);
    }
  });

  it('can still save a scan after the upgrade', () => {
    // This is what was actually broken: every snapshot write failed with
    // "no such table: main.websites_legacy", so no scan could be recorded.
    const site = db.prepare('SELECT id, owner_id FROM websites WHERE is_active = 1 LIMIT 1').get();

    const snapshot = db
      .prepare("INSERT INTO snapshots (website_id, content_text, content_hash) VALUES (?, 'x', 'h')")
      .run(site.id);
    db.prepare(
      `INSERT INTO scan_results (website_id, owner_id, period_days, new_snapshot_id, status)
       VALUES (?, ?, 30, ?, 'completed')`
    ).run(site.id, site.owner_id, snapshot.lastInsertRowid);

    // And the key is real, not merely absent: a website that does not exist is
    // refused.
    expect(() =>
      db.prepare("INSERT INTO snapshots (website_id, content_text, content_hash) VALUES (987654, 'x', 'h')").run()
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('can group the inherited websites', async () => {
    const session = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'test-admin-password' });
    const ids = db
      .prepare('SELECT id FROM websites WHERE is_active = 1 ORDER BY id LIMIT 3')
      .all()
      .map((r) => r.id);

    const res = await as(request(app).post('/api/groups'), session.body.token)
      .send({ name: 'Inherited', websiteIds: ids });

    expect(res.status).toBe(201);
    expect(res.body.website_ids.sort()).toEqual([...ids].sort());
  });

});

describe('repairing a database the old upgrade already broke', () => {
  let dbPath;
  let app;
  let db;
  let before;

  /**
   * Put a legacy database through the upgrade exactly as the old code did —
   * the rename with legacy_alter_table off — producing the state deployed
   * instances are actually in.
   */
  function breakTheWayTheOldUpgradeDid(file) {
    const migrations = require('../src/db/migrations');
    const conn = new Database(file);
    migrations.run(conn);
    const owner = conn
      .prepare(`INSERT INTO users (email, password_hash) VALUES ('admin@local', 'x')`)
      .run().lastInsertRowid;

    conn.pragma('foreign_keys = OFF');
    conn.exec(`
      BEGIN;
      ALTER TABLE websites RENAME TO websites_legacy;
      ${migrations.TENANT_WEBSITES_DDL}
    `);
    conn.prepare(
      `INSERT INTO websites (owner_id, id, url, name, created_at, is_active, domain, srms_owner)
       SELECT ?, id, url, name, created_at, is_active, domain, srms_owner FROM websites_legacy`
    ).run(owner);
    conn.exec('DROP TABLE websites_legacy; COMMIT;');
    conn.pragma('foreign_keys = ON');
    conn.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migrations.OWNERSHIP_MIGRATION);
    migrations.backfillScanOwners(conn);

    // Deleted rows leave AUTOINCREMENT above MAX(id); the repair must not let
    // those ids be handed out again, since report links carry scan ids.
    conn.prepare("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'scan_results'").run();
    conn.close();
  }

  function indexNames(conn, table) {
    return conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
      .all(table)
      .map((r) => r.name);
  }

  beforeAll(() => {
    dbPath = createLegacyDatabase();
    breakTheWayTheOldUpgradeDid(dbPath);

    // Prove the fixture reproduces the bug before trusting the repair.
    const probe = new Database(dbPath);
    probe.pragma('foreign_keys = ON');
    before = {
      write: (() => {
        try {
          probe.prepare("INSERT INTO snapshots (website_id, content_text, content_hash) VALUES (1, 'x', 'h')").run();
          return 'ok';
        } catch (err) {
          return err.message;
        }
      })(),
      snapshots: probe.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n,
      scans: probe.prepare('SELECT id, website_id, llm_summary FROM scan_results ORDER BY id').all(),
      snapshotIndexes: indexNames(probe, 'snapshots'),
      scanIndexes: indexNames(probe, 'scan_results'),
    };
    probe.close();

    Object.assign(process.env, {
      NODE_ENV: 'test',
      DB_PATH: dbPath,
      JWT_SECRET: 'repair-test-secret',
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'test-admin-password',
      DISABLE_RATE_LIMIT: '1',
      ENABLE_SCHEDULER: 'false',
    });

    resetModules();
    app = require('../src/server'); // boot runs the repair
    db = require('../src/db');
  });

  afterAll(() => {
    try { db.close(); } catch { /* already closed */ }
    cleanupDatabase(dbPath);
    resetModules();
  });

  it('starts from a genuinely broken database', () => {
    expect(before.write).toMatch(/no such table: main\.websites_legacy/);
  });

  it('points every foreign key back at a table that exists', () => {
    for (const table of ['snapshots', 'scan_results']) {
      const targets = db.prepare(`PRAGMA foreign_key_list("${table}")`).all().map((fk) => fk.table);
      expect(targets, table).not.toContain('websites_legacy');
      expect(targets, table).toContain('websites');
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('keeps every row, with the same ids', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n).toBe(before.snapshots);
    expect(
      db.prepare('SELECT id, website_id, llm_summary FROM scan_results ORDER BY id').all()
    ).toEqual(before.scans);
  });

  it('keeps the indexes', () => {
    expect(indexNames(db, 'snapshots')).toEqual(before.snapshotIndexes);
    expect(indexNames(db, 'scan_results')).toEqual(before.scanIndexes);
    expect(before.snapshotIndexes.length).toBeGreaterThan(0);
  });

  it('does not reuse ids past the highest one ever issued', () => {
    const { seq } = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'scan_results'").get();
    expect(seq).toBe(500);
  });

  it('can save a scan again, with the key enforced', () => {
    const site = db.prepare('SELECT id, owner_id FROM websites WHERE is_active = 1 LIMIT 1').get();
    const snapshot = db
      .prepare("INSERT INTO snapshots (website_id, content_text, content_hash) VALUES (?, 'x', 'h')")
      .run(site.id);
    const scan = db.prepare(
      `INSERT INTO scan_results (website_id, owner_id, period_days, new_snapshot_id, status)
       VALUES (?, ?, 30, ?, 'completed')`
    ).run(site.id, site.owner_id, snapshot.lastInsertRowid);

    expect(scan.lastInsertRowid).toBe(501);
    expect(() =>
      db.prepare("INSERT INTO snapshots (website_id, content_text, content_hash) VALUES (987654, 'x', 'h')").run()
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('took a file backup before rebuilding anything', () => {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-pre-reference-repair-`));
    expect(backups).toHaveLength(1);
  });

  it('is a no-op once repaired', () => {
    const { migrations } = require('../src/db');
    expect(migrations.tablesReferencingLegacyWebsites(db)).toEqual([]);
    expect(migrations.repairLegacyReferences(db)).toEqual([]);
  });

  it('still serves the data over the API', async () => {
    const session = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'test-admin-password' });

    const websites = await as(request(app).get('/api/websites'), session.body.token);
    expect(websites.body).toHaveLength(6);

    const scans = await as(request(app).get('/api/scans?limit=100'), session.body.token);
    expect(scans.body.total).toBe(before.scans.length + 1);
  });
});

describe('fresh database', () => {
  let dbPath;
  let db;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `wm-fresh-${crypto.randomBytes(8).toString('hex')}.db`);

    Object.assign(process.env, {
      NODE_ENV: 'test',
      DB_PATH: dbPath,
      JWT_SECRET: 'fresh-test-secret',
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'test-admin-password',
      DISABLE_RATE_LIMIT: '1',
      ENABLE_SCHEDULER: 'false',
    });

    resetModules();
    require('../src/server');
    db = require('../src/db');
  });

  afterAll(() => {
    try { db.close(); } catch { /* already closed */ }
    cleanupDatabase(dbPath);
    resetModules();
  });

  it('starts with the owner column already in place, with no rebuild needed', () => {
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'websites'")
      .get();

    expect(sql).toMatch(/UNIQUE\(owner_id,\s*url\)/i);
  });

  it('records the ownership migration as already applied', () => {
    const { migrations } = require('../src/db');
    expect(migrations.hasRun(db, migrations.OWNERSHIP_MIGRATION)).toBe(true);
  });

  it('creates the group and settings tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    for (const table of ['website_groups', 'website_group_members', 'group_schedules', 'app_settings']) {
      expect(tables).toContain(table);
    }
  });

  it('does not write a backup file when there was nothing to migrate', () => {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`));

    expect(backups).toHaveLength(0);
  });

  it('leaves the legacy billing tables empty', () => {
    // They are still created so an existing database opens unchanged, but
    // nothing writes to them any more.
    for (const table of ['plans', 'subscriptions', 'usage_counters', 'payments']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    }
  });

  it('seeds exactly one account, to own the data', () => {
    const users = db.prepare('SELECT * FROM users').all();

    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('admin@local');
    // Sign-in compares against the environment; the stored hash is never the
    // password in plaintext.
    expect(users[0].password_hash).not.toContain('test-admin-password');
  });
});
