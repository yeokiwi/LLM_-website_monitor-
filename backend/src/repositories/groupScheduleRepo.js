const db = require('../db');
const { nextRunAt } = require('./scheduleRepo');

/**
 * A group's recurring scan. Mirrors scheduleRepo deliberately — same cadences,
 * same "first run one interval out", same claim-then-run — so the two kinds of
 * schedule behave identically and only differ in what they scan.
 */

function findForGroup(ownerId, groupId) {
  return db
    .prepare('SELECT * FROM group_schedules WHERE group_id = ? AND owner_id = ?')
    .get(groupId, ownerId);
}

/**
 * Create or replace a group's schedule.
 *
 * Turning a schedule on does not scan immediately: the first run is one
 * interval out, so enabling a daily sweep of forty sites does not spend forty
 * scans the moment the dropdown changes. The next run is only re-anchored when
 * the cadence itself changes.
 */
function upsert(ownerId, groupId, { frequency, periodDays = 30, isEnabled = true }) {
  db.prepare(
    `INSERT INTO group_schedules (group_id, owner_id, frequency, period_days, is_enabled, next_run_at)
     VALUES (@group_id, @owner_id, @frequency, @period_days, @is_enabled, @next_run_at)
     ON CONFLICT(group_id) DO UPDATE SET
       frequency   = excluded.frequency,
       period_days = excluded.period_days,
       is_enabled  = excluded.is_enabled,
       next_run_at = CASE
         WHEN group_schedules.frequency != excluded.frequency THEN excluded.next_run_at
         ELSE group_schedules.next_run_at
       END`
  ).run({
    group_id: groupId,
    owner_id: ownerId,
    frequency,
    period_days: periodDays,
    is_enabled: isEnabled ? 1 : 0,
    next_run_at: nextRunAt(frequency),
  });

  return findForGroup(ownerId, groupId);
}

function remove(ownerId, groupId) {
  return db
    .prepare('DELETE FROM group_schedules WHERE group_id = ? AND owner_id = ?')
    .run(groupId, ownerId).changes;
}

/**
 * Claim the group schedules that are due, advancing `next_run_at` in the same
 * transaction that reads them — the scheduleRepo.claimDue guarantee: a restart
 * mid-run skips the run rather than repeating it, and a run costs real money.
 *
 * @returns {object[]} schedule rows joined to their group
 */
const claimDue = db.transaction((limit) => {
  const due = db
    .prepare(
      `SELECT gs.*, g.name AS group_name, g.notify_emails, g.notify_on
         FROM group_schedules gs
         JOIN website_groups g ON g.id = gs.group_id
        WHERE gs.is_enabled = 1
          AND gs.next_run_at <= ?
        ORDER BY gs.next_run_at ASC
        LIMIT ?`
    )
    .all(new Date().toISOString(), limit);

  const advance = db.prepare('UPDATE group_schedules SET next_run_at = ? WHERE id = ?');
  for (const row of due) {
    advance.run(nextRunAt(row.frequency), row.id);
  }

  return due;
});

function markRun(scheduleId, { status, changed, failed }) {
  db.prepare(
    `UPDATE group_schedules
        SET last_run_at = CURRENT_TIMESTAMP, last_status = ?, last_changed = ?, last_failed = ?
      WHERE id = ?`
  ).run(status, changed, failed, scheduleId);
}

module.exports = { findForGroup, upsert, remove, claimDue, markRun };
