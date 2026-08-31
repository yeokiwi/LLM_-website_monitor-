const db = require('../db');

/**
 * Scan results are tenant-owned via a denormalised `owner_id`, backfilled from
 * the website. Every read here filters on it.
 */

const JOINED_COLUMNS = `
  sr.*, w.url, w.name, w.domain, w.srms_owner, w.srms
`;

function list(ownerId, limit, offset) {
  const results = db
    .prepare(
      `SELECT ${JOINED_COLUMNS}
         FROM scan_results sr
         JOIN websites w ON sr.website_id = w.id
        WHERE sr.owner_id = ?
        ORDER BY sr.scanned_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(ownerId, limit, offset);

  const total = db
    .prepare('SELECT COUNT(*) AS count FROM scan_results WHERE owner_id = ?')
    .get(ownerId).count;

  return { total, results };
}

function findById(ownerId, id) {
  return db
    .prepare(
      `SELECT ${JOINED_COLUMNS}
         FROM scan_results sr
         JOIN websites w ON sr.website_id = w.id
        WHERE sr.id = ? AND sr.owner_id = ?`
    )
    .get(id, ownerId);
}

function listForWebsite(ownerId, websiteId, limit = 50) {
  return db
    .prepare(
      `SELECT * FROM scan_results
        WHERE website_id = ? AND owner_id = ?
        ORDER BY scanned_at DESC
        LIMIT ?`
    )
    .all(websiteId, ownerId, limit);
}

/**
 * Scans for the PDF export.
 *
 * With no ids, every scan the caller owns. With ids, only the ones they own —
 * the intersection is done in SQL so a crafted id list cannot pull in another
 * tenant's report.
 */
function listForExport(ownerId, ids) {
  const base = `
    SELECT ${JOINED_COLUMNS}
      FROM scan_results sr
      JOIN websites w ON sr.website_id = w.id
     WHERE sr.owner_id = ?`;

  if (Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    return db
      .prepare(`${base} AND sr.id IN (${placeholders}) ORDER BY sr.scanned_at DESC`)
      .all(ownerId, ...ids);
  }

  return db.prepare(`${base} ORDER BY sr.scanned_at DESC`).all(ownerId);
}

function updateRemark(ownerId, id, remark) {
  const result = db
    .prepare('UPDATE scan_results SET remark = ? WHERE id = ? AND owner_id = ?')
    .run(remark === null ? null : String(remark), id, ownerId);

  if (result.changes === 0) return null;

  return db.prepare('SELECT * FROM scan_results WHERE id = ?').get(id);
}

/**
 * Insert a completed scan.
 * @param {object} fields all columns; unspecified ones fall back to NULL
 */
function create(fields) {
  const result = db
    .prepare(
      `INSERT INTO scan_results (
         website_id, owner_id, period_days, old_snapshot_id, new_snapshot_id,
         diff_summary, llm_summary, status, error_message,
         triggered_by, engines_used, llm_input_tokens, llm_output_tokens, duration_ms
       ) VALUES (
         @website_id, @owner_id, @period_days, @old_snapshot_id, @new_snapshot_id,
         @diff_summary, @llm_summary, @status, @error_message,
         @triggered_by, @engines_used, @llm_input_tokens, @llm_output_tokens, @duration_ms
       )`
    )
    .run({
      old_snapshot_id: null,
      diff_summary: null,
      llm_summary: null,
      error_message: null,
      triggered_by: 'manual',
      engines_used: null,
      llm_input_tokens: null,
      llm_output_tokens: null,
      duration_ms: null,
      ...fields,
    });

  return result.lastInsertRowid;
}

/**
 * Delete snapshot bodies and scan rows older than the plan's retention window.
 *
 * Snapshot text is the bulk of the database and previously grew without bound.
 * Only `content_text` is blanked on retained-but-old snapshots so the diff
 * chain's ids stay intact.
 */
function pruneHistory(ownerId, retentionDays) {
  if (!retentionDays) return { scans: 0, snapshots: 0 };

  const cutoff = `-${retentionDays} days`;

  const scans = db
    .prepare(
      `DELETE FROM scan_results
        WHERE owner_id = ? AND scanned_at < datetime('now', ?)`
    )
    .run(ownerId, cutoff).changes;

  const snapshots = db
    .prepare(
      `UPDATE snapshots
          SET content_text = ''
        WHERE content_text != ''
          AND scraped_at < datetime('now', ?)
          AND website_id IN (SELECT id FROM websites WHERE owner_id = ?)`
    )
    .run(cutoff, ownerId).changes;

  return { scans, snapshots };
}

module.exports = {
  list,
  findById,
  listForWebsite,
  listForExport,
  updateRemark,
  create,
  pruneHistory,
};
