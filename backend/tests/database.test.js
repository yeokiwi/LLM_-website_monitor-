/**
 * Backup and restore.
 *
 * The round-trip is the whole feature, and until now none of it was tested —
 * the destructive endpoint had no coverage at all. Three defects are pinned
 * here, each of which produced a restore that looked like it had worked:
 *
 *   - schedules were not in the restore set, so a restore silently wiped every
 *     schedule and the scheduler woke up with nothing to run;
 *   - `owner_id` was copied verbatim from the backup, so restoring onto an
 *     instance with a differently-numbered account left every row owned by a
 *     user that does not exist — an empty dashboard and no error;
 *   - the export shipped the whole `users` table, password hash included.
 *
 * Each suite gets its own app and database because a restore replaces the
 * contents of the one it runs against.
 */

const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { createTestApp, signIn, ownerId, as } = require('./helpers');

/** Bring up an app, sign in, and return everything a test needs. */
async function harness() {
  const ctx = createTestApp();
  const session = await signIn(request, ctx.app);
  return { ...ctx, session, owner: ownerId(ctx.db) };
}

/** Insert a website directly, so tests do not depend on the HTTP layer. */
function addWebsite(db, owner, url, name) {
  return db
    .prepare(
      `INSERT INTO websites (owner_id, url, name, use_firecrawl, use_brave, use_serper)
       VALUES (?, ?, ?, 1, 0, 0)`
    )
    .run(owner, url, name).lastInsertRowid;
}

/** A snapshot plus the scan row that points at it. A real scan costs money. */
function addScan(db, websiteId, owner, summary) {
  const snapshot = db
    .prepare(
      `INSERT INTO snapshots (website_id, content_text, content_hash, provider)
       VALUES (?, 'page text', 'hash-1', 'direct')`
    )
    .run(websiteId);

  db.prepare(
    `INSERT INTO scan_results (website_id, owner_id, period_days, new_snapshot_id,
                               llm_summary, status)
     VALUES (?, ?, 30, ?, ?, 'completed')`
  ).run(websiteId, owner, snapshot.lastInsertRowid, summary);

  return snapshot.lastInsertRowid;
}

function addSchedule(db, websiteId, owner, frequency = 'daily') {
  db.prepare(
    `INSERT INTO schedules (website_id, owner_id, frequency, period_days, is_enabled, next_run_at)
     VALUES (?, ?, ?, 30, 1, '2030-01-01T00:00:00.000Z')`
  ).run(websiteId, owner, frequency);
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/** Download the backup and return its bytes. */
async function exportBackup(ctx, token) {
  const res = await as(request(ctx.app).get('/api/database/export'), token).buffer();
  expect(res.status).toBe(200);
  return Buffer.from(res.body);
}

/** Upload a backup. `confirm` false omits the confirmation query parameter. */
function importBackup(ctx, token, buffer, { confirm = true, filename = 'backup.db' } = {}) {
  const url = confirm
    ? '/api/database/import?confirm=replace-all-data'
    : '/api/database/import';
  return as(request(ctx.app).post(url), token).attach('file', buffer, filename);
}

/** Open a backup buffer as a real database, run `fn`, clean up. */
function withBackupOpen(buffer, fn) {
  const file = path.join(os.tmpdir(), `wm-assert-${crypto.randomBytes(6).toString('hex')}.db`);
  fs.writeFileSync(file, buffer);
  const conn = new Database(file, { readonly: true });
  try {
    return fn(conn);
  } finally {
    conn.close();
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------------------

describe('GET /api/database/export', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await harness();
    const site = addWebsite(ctx.db, ctx.owner, 'https://example.com/a', 'A');
    addScan(ctx.db, site, ctx.owner, 'Report A');
  });

  afterAll(() => ctx.cleanup());

  it('returns a real SQLite file carrying the data', async () => {
    const buffer = await exportBackup(ctx, ctx.session.token);

    expect(buffer.subarray(0, 15).toString()).toBe('SQLite format 3');
    withBackupOpen(buffer, (conn) => {
      expect(count(conn, 'websites')).toBe(1);
      expect(count(conn, 'scan_results')).toBe(1);
    });
  });

  it('carries no credentials', async () => {
    // A backup is something you hand to someone. The hash is inert — nothing
    // verifies against it — but it has no business being in the file.
    const buffer = await exportBackup(ctx, ctx.session.token);

    withBackupOpen(buffer, (conn) => {
      const users = conn.prepare('SELECT * FROM users').all();
      expect(users.length).toBeGreaterThan(0);
      for (const user of users) {
        expect(user.password_hash).toBe('');
        expect(user.verify_token).toBeNull();
        expect(user.reset_token).toBeNull();
        // The account still identifies itself, so the file stays readable.
        expect(user.email).toBeTruthy();
      }
    });

    // The live database is untouched by the scrubbing.
    const live = ctx.db.prepare('SELECT password_hash FROM users').get();
    expect(live.password_hash).not.toBe('');
  });

  it('carries no rows from the removed billing tables', async () => {
    ctx.db
      .prepare(`INSERT INTO plans (slug, name, entitlements) VALUES ('legacy', 'Legacy', '{}')`)
      .run();

    const buffer = await exportBackup(ctx, ctx.session.token);

    withBackupOpen(buffer, (conn) => {
      expect(count(conn, 'plans')).toBe(0);
      expect(count(conn, 'payments')).toBe(0);
      expect(count(conn, 'subscriptions')).toBe(0);
    });
  });
});

describe('POST /api/database/import — round trip', () => {
  let ctx;
  let backup;

  beforeAll(async () => {
    ctx = await harness();

    const first = addWebsite(ctx.db, ctx.owner, 'https://example.com/first', 'First');
    const second = addWebsite(ctx.db, ctx.owner, 'https://example.com/second', 'Second');
    addScan(ctx.db, first, ctx.owner, 'Report one');
    addScan(ctx.db, second, ctx.owner, 'Report two');
    addSchedule(ctx.db, first, ctx.owner, 'daily');
    addSchedule(ctx.db, second, ctx.owner, 'weekly');

    backup = await exportBackup(ctx, ctx.session.token);

    // Diverge from the backup: lose one site and both schedules, gain another.
    ctx.db.prepare('DELETE FROM websites WHERE id = ?').run(second);
    ctx.db.prepare('DELETE FROM schedules').run();
    addWebsite(ctx.db, ctx.owner, 'https://example.com/added-later', 'Later');
  });

  afterAll(() => ctx.cleanup());

  it('restores every table, schedules included', async () => {
    const res = await importBackup(ctx, ctx.session.token, backup);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      websites: 2,
      scan_results: 2,
      snapshots: 2,
      schedules: 2,
    });

    // The regression: schedules used not to be in the restore set, so this came
    // back 0 and the scheduler had nothing left to run.
    expect(count(ctx.db, 'schedules')).toBe(2);
    const frequencies = ctx.db
      .prepare('SELECT frequency FROM schedules ORDER BY frequency')
      .all()
      .map((r) => r.frequency);
    expect(frequencies).toEqual(['daily', 'weekly']);

    // Replace, not merge: the website added after the backup is gone.
    const urls = ctx.db.prepare('SELECT url FROM websites ORDER BY url').all().map((r) => r.url);
    expect(urls).toEqual(['https://example.com/first', 'https://example.com/second']);
  });

  it('leaves the restored data reachable through the API', async () => {
    const res = await as(request(ctx.app).get('/api/websites'), ctx.session.token);

    expect(res.status).toBe(200);
    expect(res.body.map((w) => w.url).sort()).toEqual([
      'https://example.com/first',
      'https://example.com/second',
    ]);
  });

  it('writes a backup of the replaced data first', async () => {
    const res = await importBackup(ctx, ctx.session.token, backup);

    expect(res.body.backup).toMatch(/\.bak-\d+$/);
    const sibling = path.join(path.dirname(ctx.dbPath), res.body.backup);
    expect(fs.existsSync(sibling)).toBe(true);
  });
});

describe('POST /api/database/import — re-owning', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await harness();
  });

  afterAll(() => ctx.cleanup());

  it('re-owns a backup taken under a different account', async () => {
    // The bug this pins: `owner_id` used to be copied verbatim, so a backup from
    // another instance restored into rows owned by a user id that does not exist
    // here. The dashboard rendered empty and nothing reported an error.
    const stranger = ctx.db
      .prepare(`INSERT INTO users (email, password_hash, name) VALUES (?, 'x', 'Stranger')`)
      .run('stranger@example.com').lastInsertRowid;

    const site = addWebsite(ctx.db, stranger, 'https://example.com/theirs', 'Theirs');
    addScan(ctx.db, site, stranger, 'Their report');
    addSchedule(ctx.db, site, stranger);

    const backup = await exportBackup(ctx, ctx.session.token);

    const res = await importBackup(ctx, ctx.session.token, backup);
    expect(res.status).toBe(200);

    // Everything now belongs to the account that did the restore.
    for (const table of ['websites', 'scan_results', 'schedules']) {
      const owners = ctx.db
        .prepare(`SELECT DISTINCT owner_id FROM ${table}`)
        .all()
        .map((r) => r.owner_id);
      expect(owners).toEqual([ctx.owner]);
    }

    // And is therefore visible, which is the point.
    const listed = await as(request(ctx.app).get('/api/websites'), ctx.session.token);
    expect(listed.body.map((w) => w.url)).toContain('https://example.com/theirs');
  });
});

describe('POST /api/database/import — rejections', () => {
  let ctx;
  let backup;

  beforeAll(async () => {
    ctx = await harness();
    addWebsite(ctx.db, ctx.owner, 'https://example.com/live', 'Live');
    backup = await exportBackup(ctx, ctx.session.token);
  });

  afterAll(() => ctx.cleanup());

  /** Nothing in the live database changed. */
  function liveDataIntact() {
    const urls = ctx.db.prepare('SELECT url FROM websites').all().map((r) => r.url);
    expect(urls).toEqual(['https://example.com/live']);
  }

  it('refuses without the confirmation parameter', async () => {
    const res = await importBackup(ctx, ctx.session.token, backup, { confirm: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    liveDataIntact();
  });

  it('refuses a file that is not a database, without reporting a server error', async () => {
    // A bare Error out of multer's fileFilter used to surface as a 500, which
    // reads as "the server broke" rather than "that is the wrong file".
    const res = await importBackup(ctx, ctx.session.token, Buffer.from('id,url\n1,x\n'), {
      filename: 'websites.csv',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SQLite/i);
    liveDataIntact();
  });

  it('refuses a corrupt database', async () => {
    // Keeps the SQLite magic so it gets past the filename check and as far as
    // the integrity check, which is the guard being tested.
    const corrupt = Buffer.concat([
      Buffer.from('SQLite format 3\0', 'binary'),
      crypto.randomBytes(8192),
    ]);

    const res = await importBackup(ctx, ctx.session.token, corrupt);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid backup file/);
    liveDataIntact();
  });

  it('refuses a backup with the same URL under two accounts', async () => {
    // Re-owning collapses every row onto one account, and websites are
    // UNIQUE(owner_id, url). Naming the URLs beats dropping rows on the floor.
    const other = createTestApp();
    const otherOwner = ownerId(other.db);
    const stranger = other.db
      .prepare(`INSERT INTO users (email, password_hash, name) VALUES (?, 'x', 'S')`)
      .run('s@example.com').lastInsertRowid;

    addWebsite(other.db, otherOwner, 'https://example.com/shared', 'Mine');
    addWebsite(other.db, stranger, 'https://example.com/shared', 'Theirs');
    const clashing = other.db.serialize();
    other.cleanup();

    // cleanup() reset the module cache, so bring this suite's app back.
    ctx = await harness();
    addWebsite(ctx.db, ctx.owner, 'https://example.com/live', 'Live');

    const res = await importBackup(ctx, ctx.session.token, clashing);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('https://example.com/shared');
    liveDataIntact();
  });
});
