const db = require('../db');

/**
 * Usage is tracked per billing period. The window follows the subscription's
 * own period when one exists (so a mid-month upgrade resets the allowance on
 * the day the customer is actually billed), and falls back to the calendar
 * month otherwise.
 *
 * Rows are created lazily on first use, so period rollover needs no cron job.
 */

/** `YYYY-MM-DD` in UTC. */
function toDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Resolve the current usage window for a user.
 * @param {object|null} subscription a row from subscriptionRepo, or null
 */
function currentWindow(subscription) {
  const start = subscription?.current_period_start;
  const end = subscription?.current_period_end;

  if (start && end && Date.parse(end) > Date.now() && Date.parse(start) <= Date.now()) {
    return { periodStart: toDay(start), periodEnd: toDay(end) };
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart: toDay(monthStart), periodEnd: toDay(monthEnd) };
}

const EMPTY = {
  scans_used: 0,
  llm_calls: 0,
  scrape_calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  warned_at: null,
};

/** Read the counter row for a window without creating it. */
function get(userId, window) {
  const row = db
    .prepare('SELECT * FROM usage_counters WHERE user_id = ? AND period_start = ?')
    .get(userId, window.periodStart);

  return row || { user_id: userId, ...window, ...EMPTY };
}

/** Read or create the counter row for a window. */
function getOrCreate(userId, window) {
  db.prepare(
    `INSERT INTO usage_counters (user_id, period_start, period_end)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, period_start) DO NOTHING`
  ).run(userId, window.periodStart, window.periodEnd);

  return db
    .prepare('SELECT * FROM usage_counters WHERE user_id = ? AND period_start = ?')
    .get(userId, window.periodStart);
}

const COUNTERS = ['scans_used', 'llm_calls', 'scrape_calls', 'input_tokens', 'output_tokens'];

/**
 * Add to one or more counters for the given window.
 *
 * Safe to call inside a caller's transaction — the row is created first so the
 * UPDATE always matches.
 *
 * @param {object} deltas e.g. `{ scans_used: 1, llm_calls: 2, input_tokens: 8123 }`
 */
function increment(userId, window, deltas) {
  const columns = COUNTERS.filter((c) => Number.isFinite(deltas[c]) && deltas[c] !== 0);
  if (columns.length === 0) return;

  getOrCreate(userId, window);

  const sets = columns.map((c) => `${c} = ${c} + @${c}`).join(', ');
  db.prepare(
    `UPDATE usage_counters SET ${sets}
      WHERE user_id = @user_id AND period_start = @period_start`
  ).run({
    user_id: userId,
    period_start: window.periodStart,
    ...Object.fromEntries(columns.map((c) => [c, deltas[c]])),
  });
}

/** Record that a quota warning has been emailed for this window. */
function markWarned(userId, window) {
  getOrCreate(userId, window);
  db.prepare(
    `UPDATE usage_counters SET warned_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND period_start = ?`
  ).run(userId, window.periodStart);
}

/** Aggregate platform usage for the superadmin view. */
function totalsForWindow(window) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(scans_used), 0)    AS scans_used,
              COALESCE(SUM(llm_calls), 0)     AS llm_calls,
              COALESCE(SUM(scrape_calls), 0)  AS scrape_calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM usage_counters WHERE period_start = ?`
    )
    .get(window.periodStart);
}

module.exports = {
  currentWindow,
  get,
  getOrCreate,
  increment,
  markWarned,
  totalsForWindow,
};
