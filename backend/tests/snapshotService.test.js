/**
 * Baseline selection and snapshot storage.
 *
 * The baseline lookup is the single most consequential query in the product: if
 * it returns the wrong row, every report downstream is wrong, and it is wrong
 * silently — the customer sees a plausible-looking "Initial Report" forever.
 */

const { createTestApp } = require('./helpers');

let harness;
let db;
let snapshots;
let ownerId;

/** Insert a snapshot dated a given number of days in the past. */
function snapshotAt(websiteId, daysAgo, text, { provider = 'default', formatVersion } = {}) {
  const row = snapshots.saveSnapshot(websiteId, text, provider);
  db.prepare(
    `UPDATE snapshots
        SET scraped_at = datetime('now', ?), format_version = COALESCE(?, format_version)
      WHERE id = ?`
  ).run(`-${daysAgo} days`, formatVersion ?? null, row.id);
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(row.id);
}

function newWebsite(url) {
  return db
    .prepare('INSERT INTO websites (owner_id, url, name) VALUES (?, ?, ?)')
    .run(ownerId, url, url).lastInsertRowid;
}

beforeAll(() => {
  harness = createTestApp();
  db = harness.db;
  snapshots = require('../src/services/snapshotService');

  // Bootstrap seeds a superadmin; reuse it rather than fighting its id.
  ownerId = db
    .prepare(
      `INSERT INTO users (email, password_hash, name) VALUES ('baseline@test.local', 'x', 'Baseline')
       RETURNING id`
    )
    .get().id;
});

afterAll(() => harness.cleanup());

describe('findBaselineSnapshot', () => {
  it('uses the most recent snapshot at or before the start of the period', () => {
    // A monthly scan on a 30-day period: the previous snapshot is 31 days old.
    // The old implementation excluded it and returned the snapshot just saved,
    // so the site reported `no_history` on every scan, indefinitely.
    const id = newWebsite('https://example.com/monthly');
    const previous = snapshotAt(id, 31, 'content as of last month');
    const current = snapshots.saveSnapshot(id, 'content today');

    const baseline = snapshots.findBaselineSnapshot(id, 30, 'default', current.id);

    expect(baseline).toBeDefined();
    expect(baseline.id).toBe(previous.id);
    expect(snapshots.snapshotText(baseline)).toBe('content as of last month');
  });

  it('prefers the newest of several snapshots older than the period', () => {
    const id = newWebsite('https://example.com/many-old');
    snapshotAt(id, 120, 'oldest');
    const newest = snapshotAt(id, 45, 'newest pre-period');
    const current = snapshots.saveSnapshot(id, 'today');

    const baseline = snapshots.findBaselineSnapshot(id, 30, 'default', current.id);

    expect(baseline.id).toBe(newest.id);
  });

  it('falls back to the oldest in-period snapshot when nothing predates the period', () => {
    const id = newWebsite('https://example.com/weekly');
    const oldestInPeriod = snapshotAt(id, 20, 'three weeks ago');
    snapshotAt(id, 5, 'five days ago');
    const current = snapshots.saveSnapshot(id, 'today');

    const baseline = snapshots.findBaselineSnapshot(id, 30, 'default', current.id);

    expect(baseline.id).toBe(oldestInPeriod.id);
  });

  it('never returns the snapshot saved by the current scan', () => {
    const id = newWebsite('https://example.com/first-ever');
    const current = snapshots.saveSnapshot(id, 'the only snapshot');

    expect(snapshots.findBaselineSnapshot(id, 30, 'default', current.id)).toBeUndefined();
  });

  it('ignores snapshots whose body retention has blanked', () => {
    // A pruned row would otherwise read as "the whole page was added".
    const id = newWebsite('https://example.com/pruned');
    const pruned = snapshotAt(id, 60, 'this body gets pruned');
    db.prepare("UPDATE snapshots SET content_text = '', content_gz = NULL WHERE id = ?").run(pruned.id);
    const intact = snapshotAt(id, 40, 'still here');
    const current = snapshots.saveSnapshot(id, 'today');

    expect(snapshots.findBaselineSnapshot(id, 30, 'default', current.id).id).toBe(intact.id);
  });

  it('ignores snapshots written in an older content format', () => {
    const id = newWebsite('https://example.com/legacy-format');
    snapshotAt(id, 40, 'truncated legacy body', { formatVersion: 1 });
    const current = snapshots.saveSnapshot(id, 'today');

    // No eligible baseline means one re-baselining `no_history` scan, rather
    // than a diff of a 14k-truncated body against a full one.
    expect(snapshots.findBaselineSnapshot(id, 30, 'default', current.id)).toBeUndefined();
  });

  it('keeps each engine on its own history', () => {
    const id = newWebsite('https://example.com/per-engine');
    const firecrawl = snapshotAt(id, 40, 'firecrawl body', { provider: 'firecrawl' });
    snapshotAt(id, 40, 'brave body', { provider: 'brave' });
    const current = snapshots.saveSnapshot(id, 'firecrawl today', 'firecrawl');

    const baseline = snapshots.findBaselineSnapshot(id, 30, 'firecrawl', current.id);
    expect(baseline.id).toBe(firecrawl.id);
  });
});

describe('saveSnapshot', () => {
  it('hashes and stores the full content, not a truncated prefix', () => {
    const id = newWebsite('https://example.com/long-act');

    // Two documents identical for the first 14k characters — the old truncation
    // point — differing only in a later section.
    const shared = 'A'.repeat(20000);
    const first = snapshots.saveSnapshot(id, `${shared}\nSection 42: original text`);
    const second = snapshots.saveSnapshot(id, `${shared}\nSection 42: amended text`);

    expect(first.content_hash).not.toBe(second.content_hash);
    expect(snapshots.snapshotText(second)).toContain('Section 42: amended text');
    expect(second.content_chars).toBe(shared.length + '\nSection 42: amended text'.length);
  });

  it('keeps a readable prefix in content_text and compresses the body', () => {
    const id = newWebsite('https://example.com/compressed');
    const text = 'B'.repeat(30000);
    const row = snapshots.saveSnapshot(id, text);

    expect(row.content_text.length).toBe(14000);
    expect(row.content_gz.length).toBeLessThan(text.length);
    expect(snapshots.snapshotText(row)).toBe(text);
  });

  it('reads legacy rows that have no compressed body', () => {
    const id = newWebsite('https://example.com/legacy-row');
    db.prepare(
      `INSERT INTO snapshots (website_id, content_text, content_hash, provider, format_version)
       VALUES (?, 'legacy text', 'deadbeef', 'default', 1)`
    ).run(id);
    const row = db.prepare('SELECT * FROM snapshots WHERE content_hash = ?').get('deadbeef');

    expect(snapshots.snapshotText(row)).toBe('legacy text');
  });
});
