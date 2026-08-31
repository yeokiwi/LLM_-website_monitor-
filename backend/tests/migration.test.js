/**
 * The multi-tenant migration.
 *
 * This is the only destructive schema change in the codebase: SQLite cannot
 * drop the global `UNIQUE(url)` constraint, so `websites` is rebuilt and
 * copied. It runs once, against a real customer's data, and there is no undo
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

describe('multi-tenant migration', () => {
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

  it('assigns everything to the seeded operator', () => {
    const owner = db.prepare("SELECT * FROM users WHERE role = 'superadmin'").get();
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
    const owner = db.prepare("SELECT id FROM users WHERE role = 'superadmin'").get();

    expect(migrations.backfillOwnership(db, owner.id)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM websites').get().n).toBe(7);
  });

  it('serves the inherited data to the owner over the API', async () => {
    const session = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@local', password: 'test-admin-password' });

    const websites = await as(request(app).get('/api/websites'), session.body.token);
    expect(websites.body).toHaveLength(6);
    expect(websites.body.every((w) => w.snapshot_count === 2)).toBe(true);

    const scans = await as(request(app).get('/api/scans?limit=100'), session.body.token);
    expect(scans.body.total).toBe(7);
    expect(scans.body.results[0].llm_summary).toContain('Report for legacy site');
  });

  it('now allows a second account to monitor a previously-unique URL', async () => {
    const other = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'newcomer@example.com', password: 'correct-horse-battery' });

    const res = await as(request(app).post('/api/websites'), other.body.token)
      .send({ url: 'https://legacy-1.example.com' });

    expect(res.status).toBe(201);
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

  it('starts already multi-tenant, with no rebuild needed', () => {
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'websites'")
      .get();

    expect(sql).toMatch(/UNIQUE\(owner_id,\s*url\)/i);
  });

  it('records the ownership migration as already applied', () => {
    const { migrations } = require('../src/db');
    expect(migrations.hasRun(db, migrations.OWNERSHIP_MIGRATION)).toBe(true);
  });

  it('does not write a backup file when there was nothing to migrate', () => {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`));

    expect(backups).toHaveLength(0);
  });

  it('seeds the plan catalog', () => {
    const plans = db.prepare('SELECT slug FROM plans ORDER BY sort_order').all();
    expect(plans.map((p) => p.slug)).toEqual(['free', 'pro', 'business']);
  });

  it('seeds the operator account', () => {
    const admin = db.prepare("SELECT * FROM users WHERE role = 'superadmin'").get();
    expect(admin.email).toBe('admin@local');
    expect(admin.password_hash).not.toContain('test-admin-password');
  });
});
