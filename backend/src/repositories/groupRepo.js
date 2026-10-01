const db = require('../db');

/**
 * Website groups: a named, saved set of websites.
 *
 * Owner-scoped like websiteRepo — every function takes `ownerId` and folds it
 * into the WHERE clause, so another account's group reads as "not found".
 *
 * Membership deliberately has no foreign key to `websites` (see migrations.js),
 * so the reads here join `websites` and keep only active rows, and
 * `removeWebsites` is called wherever a website is removed.
 */

/** A group row with its schedule (if any) folded in. */
const GROUP_COLUMNS = `
  g.*,
  gs.frequency    AS schedule_frequency,
  gs.period_days  AS schedule_period_days,
  gs.is_enabled   AS schedule_enabled,
  gs.next_run_at  AS schedule_next_run_at,
  gs.last_run_at  AS schedule_last_run_at,
  gs.last_status  AS schedule_last_status,
  gs.last_changed AS schedule_last_changed,
  gs.last_failed  AS schedule_last_failed
`;

/** Active member ids for each of the given group ids, as a Map. */
function memberIdsFor(groupIds) {
  const members = new Map(groupIds.map((id) => [id, []]));
  if (groupIds.length === 0) return members;

  const placeholders = groupIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.group_id, m.website_id
         FROM website_group_members m
         JOIN websites w ON w.id = m.website_id
        WHERE m.group_id IN (${placeholders}) AND w.is_active = 1
        ORDER BY w.name COLLATE NOCASE, w.url`
    )
    .all(...groupIds);

  for (const row of rows) members.get(row.group_id).push(row.website_id);
  return members;
}

/** Shape a joined row for the API. */
function present(row, websiteIds) {
  return {
    id: row.id,
    name: row.name,
    notify_emails: parseList(row.notify_emails),
    notify_on: row.notify_on,
    created_at: row.created_at,
    website_ids: websiteIds,
    member_count: websiteIds.length,
    schedule: row.schedule_frequency
      ? {
          frequency: row.schedule_frequency,
          period_days: row.schedule_period_days,
          is_enabled: Boolean(row.schedule_enabled),
          next_run_at: row.schedule_next_run_at,
          last_run_at: row.schedule_last_run_at,
          last_status: row.schedule_last_status,
          last_changed: row.schedule_last_changed,
          last_failed: row.schedule_last_failed,
        }
      : null,
  };
}

function parseList(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function listForOwner(ownerId) {
  const rows = db
    .prepare(
      `SELECT ${GROUP_COLUMNS}
         FROM website_groups g
         LEFT JOIN group_schedules gs ON gs.group_id = g.id
        WHERE g.owner_id = ?
        ORDER BY g.name COLLATE NOCASE`
    )
    .all(ownerId);

  const members = memberIdsFor(rows.map((r) => r.id));
  return rows.map((row) => present(row, members.get(row.id)));
}

function findById(ownerId, id) {
  const row = db
    .prepare(
      `SELECT ${GROUP_COLUMNS}
         FROM website_groups g
         LEFT JOIN group_schedules gs ON gs.group_id = g.id
        WHERE g.id = ? AND g.owner_id = ?`
    )
    .get(id, ownerId);

  if (!row) return null;
  return present(row, memberIdsFor([row.id]).get(row.id));
}

function findByName(ownerId, name) {
  return db
    .prepare('SELECT id FROM website_groups WHERE owner_id = ? AND name = ?')
    .get(ownerId, name);
}

/**
 * The group's active member websites, in full — what a scan needs.
 * Not owner-scoped: the scheduler calls it with a group it has already claimed.
 */
function activeMembers(groupId) {
  return db
    .prepare(
      `SELECT w.*
         FROM website_group_members m
         JOIN websites w ON w.id = m.website_id
        WHERE m.group_id = ? AND w.is_active = 1
        ORDER BY w.name COLLATE NOCASE, w.url`
    )
    .all(groupId);
}

/** Replace a group's membership with exactly these website ids. */
function setMembers(groupId, websiteIds) {
  db.prepare('DELETE FROM website_group_members WHERE group_id = ?').run(groupId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO website_group_members (group_id, website_id) VALUES (?, ?)'
  );
  for (const websiteId of websiteIds) insert.run(groupId, websiteId);
}

/**
 * Create a group with its members.
 * @returns {object} the presented group
 */
const create = db.transaction((ownerId, { name, websiteIds, notifyEmails, notifyOn }) => {
  const result = db
    .prepare(
      `INSERT INTO website_groups (owner_id, name, notify_emails, notify_on)
       VALUES (?, ?, ?, ?)`
    )
    .run(ownerId, name, JSON.stringify(notifyEmails || []), notifyOn || 'changes');

  setMembers(result.lastInsertRowid, websiteIds);
  return findById(ownerId, result.lastInsertRowid);
});

/**
 * Update any of a group's fields. Only the keys present are changed.
 * @returns {object|null} the presented group, or null when not found
 */
const update = db.transaction((ownerId, id, { name, websiteIds, notifyEmails, notifyOn }) => {
  const existing = db
    .prepare('SELECT id FROM website_groups WHERE id = ? AND owner_id = ?')
    .get(id, ownerId);
  if (!existing) return null;

  const sets = [];
  const values = [];
  if (name !== undefined) {
    sets.push('name = ?');
    values.push(name);
  }
  if (notifyEmails !== undefined) {
    sets.push('notify_emails = ?');
    values.push(JSON.stringify(notifyEmails));
  }
  if (notifyOn !== undefined) {
    sets.push('notify_on = ?');
    values.push(notifyOn);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE website_groups SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  if (websiteIds !== undefined) setMembers(id, websiteIds);
  return findById(ownerId, id);
});

/** Delete a group. Members and its schedule go with it by cascade. */
function remove(ownerId, id) {
  return db
    .prepare('DELETE FROM website_groups WHERE id = ? AND owner_id = ?')
    .run(id, ownerId).changes;
}

/**
 * Drop these websites from every group the owner has.
 *
 * Called beside the schedule cleanup when websites are removed. Without it a
 * removed URL that is added again comes back as the same row and id
 * (websiteRepo.create reactivates it) — and quietly rejoins its old groups.
 */
function removeWebsites(ownerId, websiteIds) {
  if (!Array.isArray(websiteIds) || websiteIds.length === 0) return 0;
  const placeholders = websiteIds.map(() => '?').join(',');
  return db
    .prepare(
      `DELETE FROM website_group_members
        WHERE website_id IN (${placeholders})
          AND group_id IN (SELECT id FROM website_groups WHERE owner_id = ?)`
    )
    .run(...websiteIds, ownerId).changes;
}

/**
 * For each active website, the names of scheduled groups that include it.
 * Lets the Schedules page flag a site that is also scanned through a group.
 */
function scheduledGroupNamesByWebsite(ownerId) {
  const rows = db
    .prepare(
      `SELECT m.website_id, g.name
         FROM website_group_members m
         JOIN website_groups g   ON g.id = m.group_id
         JOIN group_schedules gs ON gs.group_id = g.id
        WHERE g.owner_id = ? AND gs.is_enabled = 1
        ORDER BY g.name COLLATE NOCASE`
    )
    .all(ownerId);

  const byWebsite = {};
  for (const row of rows) {
    (byWebsite[row.website_id] ||= []).push(row.name);
  }
  return byWebsite;
}

module.exports = {
  listForOwner,
  findById,
  findByName,
  activeMembers,
  create,
  update,
  remove,
  removeWebsites,
  scheduledGroupNamesByWebsite,
  parseList,
};
