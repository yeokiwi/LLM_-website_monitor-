const db = require('../db');

/** How far apart each frequency's runs are, in milliseconds. */
const INTERVAL_MS = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
};

const FREQUENCIES = Object.keys(INTERVAL_MS);

/** The next run time for a frequency, measured from `from`. */
function nextRunAt(frequency, from = Date.now()) {
  const interval = INTERVAL_MS[frequency];
  if (!interval) throw new Error(`Unknown schedule frequency: ${frequency}`);
  return new Date(from + interval).toISOString();
}

function findForWebsite(ownerId, websiteId) {
  return db
    .prepare('SELECT * FROM schedules WHERE website_id = ? AND owner_id = ?')
    .get(websiteId, ownerId);
}

function listForOwner(ownerId) {
  return db
    .prepare(
      `SELECT s.*, w.url, w.name
         FROM schedules s
         JOIN websites w ON w.id = s.website_id
        WHERE s.owner_id = ? AND w.is_active = 1
        ORDER BY s.next_run_at ASC`
    )
    .all(ownerId);
}

/**
 * Create or replace the schedule for a website.
 *
 * The first run is placed one interval out rather than immediately, so turning
 * on a daily schedule does not fire a scan (and spend a quota unit) the moment
 * the toggle is flipped.
 */
function upsert(ownerId, websiteId, { frequency, periodDays = 30, isEnabled = true }) {
  db.prepare(
    `INSERT INTO schedules (website_id, owner_id, frequency, period_days, is_enabled, next_run_at)
     VALUES (@website_id, @owner_id, @frequency, @period_days, @is_enabled, @next_run_at)
     ON CONFLICT(website_id) DO UPDATE SET
       frequency   = excluded.frequency,
       period_days = excluded.period_days,
       is_enabled  = excluded.is_enabled,
       next_run_at = CASE
         -- Only re-anchor the next run when the cadence itself changed.
         WHEN schedules.frequency != excluded.frequency THEN excluded.next_run_at
         ELSE schedules.next_run_at
       END`
  ).run({
    website_id: websiteId,
    owner_id: ownerId,
    frequency,
    period_days: periodDays,
    is_enabled: isEnabled ? 1 : 0,
    next_run_at: nextRunAt(frequency),
  });

  return findForWebsite(ownerId, websiteId);
}

function removeForWebsite(websiteId) {
  return db.prepare('DELETE FROM schedules WHERE website_id = ?').run(websiteId).changes;
}

function remove(ownerId, websiteId) {
  return db
    .prepare('DELETE FROM schedules WHERE website_id = ? AND owner_id = ?')
    .run(websiteId, ownerId).changes;
}

/**
 * Claim the schedules that are due, advancing `next_run_at` in the same
 * transaction that reads them.
 *
 * Claiming before running is what makes a mid-scan restart safe: the row is
 * already booked for its next slot, so the interrupted run is skipped rather
 * than repeated (and re-charged) on the next tick.
 *
 * @returns {object[]} rows joined to their website, ready to scan
 */
const claimDue = db.transaction((limit) => {
  const due = db
    .prepare(
      `SELECT s.*, w.url, w.name, w.use_firecrawl, w.use_brave, w.use_serper, w.owner_id
         FROM schedules s
         JOIN websites w ON w.id = s.website_id
        WHERE s.is_enabled = 1
          AND w.is_active = 1
          AND s.next_run_at <= ?
        ORDER BY s.next_run_at ASC
        LIMIT ?`
    )
    .all(new Date().toISOString(), limit);

  const advance = db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?');
  for (const row of due) {
    advance.run(nextRunAt(row.frequency), row.id);
  }

  return due;
});

function markRun(scheduleId, status) {
  db.prepare(
    'UPDATE schedules SET last_run_at = CURRENT_TIMESTAMP, last_status = ? WHERE id = ?'
  ).run(status, scheduleId);
}

/**
 * Disable schedules whose frequency the owner's plan no longer permits.
 * Called after a downgrade so an hourly schedule cannot outlive the plan that
 * paid for it.
 */
function disableDisallowed(ownerId, allowedFrequencies) {
  if (!Array.isArray(allowedFrequencies) || allowedFrequencies.length === 0) {
    return db
      .prepare('UPDATE schedules SET is_enabled = 0 WHERE owner_id = ? AND is_enabled = 1')
      .run(ownerId).changes;
  }

  const placeholders = allowedFrequencies.map(() => '?').join(',');
  return db
    .prepare(
      `UPDATE schedules SET is_enabled = 0
        WHERE owner_id = ? AND is_enabled = 1 AND frequency NOT IN (${placeholders})`
    )
    .run(ownerId, ...allowedFrequencies).changes;
}

module.exports = {
  FREQUENCIES,
  INTERVAL_MS,
  nextRunAt,
  findForWebsite,
  listForOwner,
  upsert,
  remove,
  removeForWebsite,
  claimDue,
  markRun,
  disableDisallowed,
};
