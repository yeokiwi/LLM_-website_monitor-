/**
 * Background scheduled scans.
 *
 * The deployment is a single container, so this is a plain in-process timer
 * rather than a queue or a separate worker — there is no second replica to
 * coordinate with, and adding a broker would be infrastructure without a
 * problem to solve.
 *
 * Two properties matter:
 *
 *   • No double-charging. `scheduleRepo.claimDue` advances `next_run_at` in the
 *     same transaction that reads the due rows, so a crash mid-scan means the
 *     run is skipped, never repeated. A scan costs real money; running one
 *     twice is worse than missing one.
 *
 *   • No overlap. A tick that is still working blocks the next one, so a slow
 *     batch cannot pile up behind itself.
 */

const cron = require('node-cron');

const scheduleRepo = require('../repositories/scheduleRepo');
const userRepo = require('../repositories/userRepo');
const scanRepo = require('../repositories/scanRepo');
const usageRepo = require('../repositories/usageRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const entitlements = require('./entitlements');
const { runSingleScan } = require('./scanService');
const mailer = require('./mailer');
const emails = require('./emails');

/** How many schedules one tick will process. Keeps a tick bounded. */
const BATCH_SIZE = 25;

/** Warn a customer once per period when they cross this share of their scans. */
const WARN_AT = 0.8;

let task = null;
let running = false;

function isEnabled() {
  const flag = process.env.ENABLE_SCHEDULER;
  if (flag !== undefined && flag !== '') return /^(1|true|yes)$/i.test(flag);
  return process.env.NODE_ENV === 'production';
}

/**
 * Run one due schedule.
 * @returns {Promise<string>} the status recorded against the schedule
 */
async function runSchedule(row) {
  const ownerId = row.owner_id;

  // Re-check the plan at run time. A downgrade between the schedule being
  // created and it firing must not keep a cadence the customer no longer pays
  // for — and the entitlement check in the route cannot see the future.
  const allowedFrequencies = entitlements.allowedSchedules(ownerId);
  if (!allowedFrequencies.includes(row.frequency)) {
    scheduleRepo.disableDisallowed(ownerId, allowedFrequencies);
    return 'plan_disallows';
  }

  const remaining = entitlements.remainingScans(ownerId);
  if (remaining !== null && remaining < 1) {
    await warnQuotaExhausted(ownerId);
    return 'quota_exceeded';
  }

  const website = {
    id: row.website_id,
    owner_id: ownerId,
    url: row.url,
    name: row.name,
    use_firecrawl: row.use_firecrawl,
    use_brave: row.use_brave,
    use_serper: row.use_serper,
  };

  const result = await runSingleScan(website, row.period_days, 'schedule');

  if (result.status === 'completed') {
    await notifyChangeDetected(ownerId, website, result);
  }

  await maybeWarnApproachingQuota(ownerId);

  return result.status;
}

async function notifyChangeDetected(ownerId, website, result) {
  if (!entitlements.hasFeature(ownerId, 'email_alerts')) return;

  const user = userRepo.findById(ownerId);
  if (!user || !user.notify_changes || !result.scanId) return;

  const message = emails.changeDetected({
    websiteName: website.name,
    websiteUrl: website.url,
    scanId: result.scanId,
    summary: result.llm_summary,
  });

  await mailer.send({ to: user.email, ...message });
}

/** One "you are running low" email per billing period, not per scan. */
async function maybeWarnApproachingQuota(ownerId) {
  const usage = entitlements.getUsage(ownerId);
  const { limit, used } = usage.scans;

  if (limit === null || used < limit * WARN_AT || used >= limit) return;

  const counters = usageRepo.get(ownerId, usage.window);
  if (counters.warned_at) return;

  const user = userRepo.findById(ownerId);
  if (!user || !user.notify_billing) return;

  usageRepo.markWarned(ownerId, usage.window);
  await mailer.send({
    to: user.email,
    ...emails.quotaWarning({ used, limit, periodEnd: usage.window.periodEnd }),
  });
}

async function warnQuotaExhausted(ownerId) {
  const usage = entitlements.getUsage(ownerId);
  const counters = usageRepo.get(ownerId, usage.window);
  if (counters.warned_at) return;

  const user = userRepo.findById(ownerId);
  if (!user || !user.notify_billing) return;

  usageRepo.markWarned(ownerId, usage.window);
  await mailer.send({
    to: user.email,
    ...emails.quotaExhausted({
      limit: usage.scans.limit,
      periodEnd: usage.window.periodEnd,
    }),
  });
}

/**
 * Process every schedule that is currently due.
 * Exported so tests can drive it without waiting for the timer.
 */
async function tick() {
  if (running) return { skipped: true };
  running = true;

  try {
    const due = scheduleRepo.claimDue(BATCH_SIZE);
    if (due.length === 0) return { ran: 0 };

    console.log(`⏱  Running ${due.length} scheduled scan(s)`);

    for (const row of due) {
      let status;
      try {
        status = await runSchedule(row);
      } catch (err) {
        console.error(`Scheduled scan failed for ${row.url}:`, err.message);
        status = 'error';
      }
      scheduleRepo.markRun(row.id, status);
    }

    return { ran: due.length };
  } finally {
    running = false;
  }
}

/**
 * Delete history past each plan's retention window.
 *
 * Snapshot text is the bulk of the database and previously grew without bound.
 * Run daily rather than per-scan so it never sits on a request's latency.
 */
function pruneRetention() {
  const users = userRepo.listAll(10_000, 0);

  for (const user of users) {
    const retention = entitlements.getEntitlements(user.id).history_retention_days;
    if (!retention) continue;

    const { scans, snapshots } = scanRepo.pruneHistory(user.id, retention);
    if (scans > 0 || snapshots > 0) {
      console.log(
        `🧹 Pruned ${scans} scan(s) and ${snapshots} snapshot body/bodies for ${user.email}`
      );
    }
  }
}

/** Start the background timers. Safe to call twice. */
function start() {
  if (task) return task;

  if (!isEnabled()) {
    console.log('   Scheduler   : disabled (set ENABLE_SCHEDULER=true to enable)');
    return null;
  }

  // Every five minutes: fine-grained enough for an hourly cadence, coarse
  // enough that an idle instance is not constantly waking up.
  task = cron.schedule('*/5 * * * *', () => {
    tick().catch((err) => console.error('Scheduler tick failed:', err));
  });

  cron.schedule('30 3 * * *', () => {
    try {
      pruneRetention();
    } catch (err) {
      console.error('Retention pruning failed:', err);
    }
  });

  console.log('   Scheduler   : enabled (every 5 minutes)');
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop, tick, pruneRetention, isEnabled, BATCH_SIZE };
