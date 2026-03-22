const crypto = require('crypto');
const db = require('../db');

/**
 * Save a new snapshot for a website.
 * @param {number} websiteId
 * @param {string} contentText
 * @returns {object} snapshot row
 */
function saveSnapshot(websiteId, contentText) {
  const hash = crypto.createHash('sha256').update(contentText).digest('hex');

  const stmt = db.prepare(`
    INSERT INTO snapshots (website_id, content_text, content_hash)
    VALUES (?, ?, ?)
  `);

  const result = stmt.run(websiteId, contentText, hash);

  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Find the oldest snapshot for a website within the given period.
 * Used as the "baseline" to compare against the current snapshot.
 *
 * @param {number} websiteId
 * @param {number} periodDays  - look back this many days from now
 * @returns {object|null}      - snapshot row or null if none found
 */
function findBaselineSnapshot(websiteId, periodDays) {
  return db
    .prepare(
      `
      SELECT * FROM snapshots
      WHERE website_id = ?
        AND scraped_at >= datetime('now', ? || ' days')
      ORDER BY scraped_at ASC
      LIMIT 1
    `
    )
    .get(websiteId, `-${periodDays}`);
}

/**
 * Get the most recent snapshot for a website (before a given snapshot id).
 */
function getPreviousSnapshot(websiteId, beforeId) {
  return db
    .prepare(
      `
      SELECT * FROM snapshots
      WHERE website_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT 1
    `
    )
    .get(websiteId, beforeId);
}

/**
 * Get all snapshots for a website (most recent first).
 */
function getSnapshots(websiteId, limit = 20) {
  return db
    .prepare(
      `
      SELECT id, website_id, content_hash, scraped_at
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
  findBaselineSnapshot,
  getPreviousSnapshot,
  getSnapshots,
  getSnapshot,
};
