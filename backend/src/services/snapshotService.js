const crypto = require('crypto');
const zlib = require('zlib');
const db = require('../db');

/**
 * How the snapshot body was built.
 *
 * 1 — legacy: content truncated to 14,000 characters before hashing, search
 *     results formatted in raw API order with relative ages ("3 days ago")
 *     embedded in the text.
 * 2 — current: full content stored and hashed, search results canonicalised
 *     (sorted, no ordinals, no relative ages).
 *
 * A v1 snapshot can never be a useful baseline for a v2 one — everything past
 * 14k reads as added and every search line reads as moved — so the baseline
 * lookup requires the current version and re-baselines once instead.
 */
const FORMAT_VERSION = 2;

/** Readable prefix kept in `content_text`; the full body lives in `content_gz`. */
const PREVIEW_CHARS = 14000;

/**
 * Save a new snapshot for a website.
 *
 * The hash covers the *whole* content, not a prefix: a change in the later
 * sections of a long Act or PDF has to be detectable, and previously was not.
 *
 * @param {number} websiteId
 * @param {string} contentText
 * @param {string} [provider='default'] - scraper engine the content came from
 * @returns {object} snapshot row
 */
function saveSnapshot(websiteId, contentText, provider = 'default') {
  const full = contentText || '';
  const hash = crypto.createHash('sha256').update(full).digest('hex');
  const gz = zlib.gzipSync(Buffer.from(full, 'utf8'));

  const stmt = db.prepare(`
    INSERT INTO snapshots (
      website_id, content_text, content_hash, provider,
      content_gz, content_chars, format_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    websiteId,
    full.slice(0, PREVIEW_CHARS),
    hash,
    provider,
    gz,
    full.length,
    FORMAT_VERSION
  );

  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * The full text of a snapshot row.
 *
 * Every diff and every LLM comparison must go through this rather than reading
 * `content_text` directly, which holds only the readable prefix on current rows
 * and is blanked entirely by retention pruning.
 *
 * @param {object|null|undefined} row
 * @returns {string}
 */
function snapshotText(row) {
  if (!row) return '';
  if (row.content_gz) {
    try {
      return zlib.gunzipSync(row.content_gz).toString('utf8');
    } catch {
      // Corrupt or foreign-encoded blob — fall back to the readable prefix
      // rather than failing the scan outright.
    }
  }
  return row.content_text || '';
}

/**
 * Find the baseline snapshot to compare the current scan against: the most
 * recent snapshot taken at or before the start of the monitoring period, and
 * failing that the oldest snapshot inside it.
 *
 * The previous implementation took the oldest snapshot *within* the period and
 * ran after the new snapshot had been saved. On a regular cadence that is
 * always wrong: scanning monthly with a 30-day period leaves the previous
 * snapshot 31 days old and therefore excluded, so the only match is the row
 * just written and the site reports `no_history` forever.
 *
 * Two rows are never eligible as a baseline:
 *   - snapshots whose body was blanked by retention pruning, which would make
 *     the entire page read as newly added;
 *   - snapshots written in an older content format (see FORMAT_VERSION).
 *
 * @param {number} websiteId
 * @param {number} periodDays  - length of the monitoring period, in days
 * @param {string} [provider='default'] - only consider this engine's snapshots
 * @param {number} [excludeId=0] - id of the snapshot just saved for this scan
 * @returns {object|undefined} - snapshot row, or undefined when there is no history
 */
function findBaselineSnapshot(websiteId, periodDays, provider = 'default', excludeId = 0) {
  const cutoff = `-${periodDays} days`;

  const atOrBeforePeriodStart = db
    .prepare(
      `
      SELECT * FROM snapshots
      WHERE website_id = ?
        AND provider = ?
        AND id <> ?
        AND format_version = ?
        AND (content_gz IS NOT NULL OR content_text <> '')
        AND scraped_at <= datetime('now', ?)
      ORDER BY scraped_at DESC
      LIMIT 1
    `
    )
    .get(websiteId, provider, excludeId, FORMAT_VERSION, cutoff);

  if (atOrBeforePeriodStart) return atOrBeforePeriodStart;

  return db
    .prepare(
      `
      SELECT * FROM snapshots
      WHERE website_id = ?
        AND provider = ?
        AND id <> ?
        AND format_version = ?
        AND (content_gz IS NOT NULL OR content_text <> '')
        AND scraped_at > datetime('now', ?)
      ORDER BY scraped_at ASC
      LIMIT 1
    `
    )
    .get(websiteId, provider, excludeId, FORMAT_VERSION, cutoff);
}

/**
 * Get the most recent snapshot for a website before a given snapshot id.
 * When `provider` is supplied, only that engine's snapshots are considered.
 *
 * @param {number} websiteId
 * @param {number} beforeId
 * @param {string} [provider] - optional engine scope (e.g. 'pdf')
 * @returns {object|undefined}
 */
function getPreviousSnapshot(websiteId, beforeId, provider) {
  if (provider !== undefined) {
    return db
      .prepare(
        `
        SELECT * FROM snapshots
        WHERE website_id = ? AND provider = ? AND id < ?
          AND format_version = ?
          AND (content_gz IS NOT NULL OR content_text <> '')
        ORDER BY id DESC
        LIMIT 1
      `
      )
      .get(websiteId, provider, beforeId, FORMAT_VERSION);
  }

  return db
    .prepare(
      `
      SELECT * FROM snapshots
      WHERE website_id = ? AND id < ?
        AND format_version = ?
        AND (content_gz IS NOT NULL OR content_text <> '')
      ORDER BY id DESC
      LIMIT 1
    `
    )
    .get(websiteId, beforeId, FORMAT_VERSION);
}

/**
 * Get all snapshots for a website (most recent first).
 */
function getSnapshots(websiteId, limit = 20) {
  return db
    .prepare(
      `
      SELECT id, website_id, content_hash, content_chars, scraped_at
      FROM snapshots
      WHERE website_id = ?
      ORDER BY scraped_at DESC
      LIMIT ?
    `
    )
    .all(websiteId, limit);
}

/**
 * Get a single snapshot by ID.
 */
function getSnapshot(id) {
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
}

module.exports = {
  saveSnapshot,
  snapshotText,
  findBaselineSnapshot,
  getPreviousSnapshot,
  getSnapshots,
  getSnapshot,
  FORMAT_VERSION,
};
