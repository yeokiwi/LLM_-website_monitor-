const db = require('../db');

/**
 * Websites are tenant-owned. Every function here takes `ownerId` first and
 * folds it into the WHERE clause, so there is no way to reach another
 * customer's row by guessing an id — a cross-tenant lookup simply returns
 * nothing, which routes surface as 404 rather than 403 (a 403 would confirm the
 * row exists).
 */

const LIST_COLUMNS = `
  w.*,
  (SELECT scraped_at FROM snapshots WHERE website_id = w.id ORDER BY scraped_at DESC LIMIT 1)
    AS last_scanned_at,
  (SELECT COUNT(*) FROM snapshots WHERE website_id = w.id)
    AS snapshot_count
`;

function listActive(ownerId) {
  return db
    .prepare(
      `SELECT ${LIST_COLUMNS},
              s.frequency AS schedule_frequency,
              s.is_enabled AS schedule_enabled,
              s.next_run_at AS schedule_next_run_at
         FROM websites w
         LEFT JOIN schedules s ON s.website_id = w.id
        WHERE w.owner_id = ? AND w.is_active = 1
        ORDER BY w.created_at DESC`
    )
    .all(ownerId);
}

function countActive(ownerId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM websites WHERE owner_id = ? AND is_active = 1')
    .get(ownerId).n;
}

function findById(ownerId, id) {
  return db
    .prepare('SELECT * FROM websites WHERE id = ? AND owner_id = ?')
    .get(id, ownerId);
}

function findActiveById(ownerId, id) {
  return db
    .prepare('SELECT * FROM websites WHERE id = ? AND owner_id = ? AND is_active = 1')
    .get(id, ownerId);
}

function findByUrl(ownerId, url) {
  return db
    .prepare('SELECT * FROM websites WHERE owner_id = ? AND url = ?')
    .get(ownerId, url);
}

/** Active websites from the given ids that this owner actually owns. */
function findActiveByIds(ownerId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM websites
        WHERE id IN (${placeholders}) AND owner_id = ? AND is_active = 1`
    )
    .all(...ids, ownerId);
}

/**
 * Insert a website, or reactivate the owner's existing row for the same URL.
 * Re-adding a previously removed site should bring back its history rather than
 * fail on the unique constraint.
 */
function create(ownerId, { url, name, domain, srms_owner, srms }) {
  const existing = findByUrl(ownerId, url);

  if (existing) {
    db.prepare(
      `UPDATE websites
          SET is_active = 1,
              name       = COALESCE(?, name),
              domain     = COALESCE(?, domain),
              srms_owner = COALESCE(?, srms_owner),
              srms       = COALESCE(?, srms)
        WHERE id = ?`
    ).run(name || null, domain || null, srms_owner || null, srms || null, existing.id);

    return { website: findById(ownerId, existing.id), created: false };
  }

  const result = db
    .prepare(
      `INSERT INTO websites (owner_id, url, name, domain, srms_owner, srms)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(ownerId, url, name || null, domain || null, srms_owner || null, srms || null);

  return { website: findById(ownerId, result.lastInsertRowid), created: true };
}

const UPDATABLE_FLAGS = ['use_firecrawl', 'use_brave', 'use_serper'];

function update(ownerId, id, fields) {
  const sets = [];
  const values = [];

  for (const flag of UPDATABLE_FLAGS) {
    if (fields[flag] !== undefined) {
      sets.push(`${flag} = ?`);
      values.push(fields[flag] ? 1 : 0);
    }
  }
  if (fields.remark !== undefined) {
    sets.push('remark = ?');
    values.push(fields.remark === null ? null : String(fields.remark));
  }
  if (fields.name !== undefined) {
    sets.push('name = ?');
    values.push(fields.name === null ? null : String(fields.name));
  }

  if (sets.length === 0) return { changes: 0, website: null };

  values.push(id, ownerId);
  const result = db
    .prepare(`UPDATE websites SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`)
    .run(...values);

  return { changes: result.changes, website: findById(ownerId, id) };
}

/** Soft delete — history is kept so a re-add restores the timeline. */
function deactivate(ownerId, id) {
  return db
    .prepare('UPDATE websites SET is_active = 0 WHERE id = ? AND owner_id = ?')
    .run(id, ownerId).changes;
}

function deactivateMany(ownerId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `UPDATE websites SET is_active = 0 WHERE id IN (${placeholders}) AND owner_id = ?`
    )
    .run(...ids, ownerId).changes;
}

/**
 * Apply engine flags to many of the owner's websites.
 * Omitting `ids` targets all of the owner's active websites — never anyone
 * else's, which the previous global version did.
 */
function updateFlagsBulk(ownerId, ids, flags) {
  const sets = [];
  const values = [];

  for (const flag of UPDATABLE_FLAGS) {
    if (flags[flag] !== undefined) {
      sets.push(`${flag} = ?`);
      values.push(flags[flag] ? 1 : 0);
    }
  }
  if (sets.length === 0) return 0;

  let where = 'owner_id = ? AND is_active = 1';
  values.push(ownerId);

  if (Array.isArray(ids) && ids.length > 0) {
    where += ` AND id IN (${ids.map(() => '?').join(',')})`;
    values.push(...ids);
  }

  return db.prepare(`UPDATE websites SET ${sets.join(', ')} WHERE ${where}`).run(...values)
    .changes;
}

/** Columns used by the spreadsheet export, in export order. */
function listForExport(ownerId) {
  return db
    .prepare(
      `SELECT url, name, domain, srms_owner, srms, use_firecrawl, use_brave, use_serper
         FROM websites
        WHERE owner_id = ? AND is_active = 1
        ORDER BY created_at DESC`
    )
    .all(ownerId);
}

/**
 * Deactivate the owner's newest websites until only `keep` remain active.
 *
 * Used when a downgrade drops the allowance below current usage. Data is never
 * deleted — the sites are simply parked, and re-upgrading brings them back.
 */
function deactivateOverLimit(ownerId, keep) {
  if (keep === null || keep === undefined) return 0;

  return db
    .prepare(
      `UPDATE websites SET is_active = 0
        WHERE id IN (
          SELECT id FROM websites
           WHERE owner_id = ? AND is_active = 1
           ORDER BY created_at DESC
           LIMIT -1 OFFSET ?
        )`
    )
    .run(ownerId, keep).changes;
}

module.exports = {
  listActive,
  countActive,
  findById,
  findActiveById,
  findByUrl,
  findActiveByIds,
  create,
  update,
  deactivate,
  deactivateMany,
  updateFlagsBulk,
  listForExport,
  deactivateOverLimit,
};
