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
 *
 * Two kinds of schedule are run: a single website's, and a group's. A group run
 * scans every active member and sends one digest to the group's recipients. A
 * site is scanned at most once per tick however many due schedules include it,
 * so a site in two groups — or in a group and on its own schedule — is paid for
 * once and reported in each.
 */

const cron = require('node-cron');

const scheduleRepo = require('../repositories/scheduleRepo');
const groupScheduleRepo = require('../repositories/groupScheduleRepo');
const groupRepo = require('../repositories/groupRepo');
const userRepo = require('../repositories/userRepo');
const scanRepo = require('../repositories/scanRepo');
const { runSingleScan } = require('./scanService');
const mailer = require('./mailer');
const emails = require('./emails');
const notifications = require('./notifications');

/** How many website schedules one tick will process. Keeps a tick bounded. */
const BATCH_SIZE = 25;

/**
 * How many group schedules one tick will process. Smaller, because each group
 * is many scans; anything not claimed stays due and runs on a later tick.
 */
const GROUP_BATCH_SIZE = 5;

const FREQUENCY_LABELS = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };

/**
 * How long scan history is kept, in days. Unset means keep everything.
 *
 * Snapshot bodies are the bulk of the database, so on a long-running instance
 * this is the difference between a file that stabilises and one that does not.
 */
function retentionDays() {
  const configured = parseInt(process.env.HISTORY_RETENTION_DAYS, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

let task = null;
let running = false;

function isEnabled() {
  const flag = process.env.ENABLE_SCHEDULER;
  if (flag !== undefined && flag !== '') return /^(1|true|yes)$/i.test(flag);
  return process.env.NODE_ENV === 'production';
}

/**
 * Run one due website schedule.
 * @param {object} row          the claimed schedule joined to its website
 * @param {Function} scanOnce   the tick's de-duplicating scan
 * @returns {Promise<string>} the status recorded against the schedule
 */
async function runSchedule(row, scanOnce) {
  const ownerId = row.owner_id;

  const website = {
    id: row.website_id,
    owner_id: ownerId,
    url: row.url,
    name: row.name,
    use_firecrawl: row.use_firecrawl,
    use_brave: row.use_brave,
    use_serper: row.use_serper,
  };

  const result = await scanOnce(website, row.period_days, 'schedule');

  // `partial` also means changes were found — one engine just did not report.
  // Keying the alert off the status alone would drop those notifications.
  if (result.changesFound) {
    await notifyChangeDetected(ownerId, website, result);
  }

  return result.status;
}

async function notifyChangeDetected(ownerId, website, result) {
  if (!result.scanId) return;

  const { recipients } = notifications.recipientsFor({ ownerId });
  if (recipients.length === 0) {
    console.log(
      `📧 Changes on ${website.url}, but there is nobody to tell — ` +
        'add a default recipient on the Schedules page'
    );
    return;
  }

  const message = emails.changeDetected({
    websiteName: website.name,
    websiteUrl: website.url,
    scanId: result.scanId,
    summary: result.llm_summary,
  });

  // `mailer.send` logs instead of sending when SMTP is not configured, and never
  // throws, so one bad address cannot stop the rest.
  for (const to of recipients) {
    await mailer.send({ to, ...message });
  }
}

/**
 * Run one due group schedule: scan every active member, record the outcome,
 * and send one digest when the group asks for one.
 *
 * @returns {Promise<{ status: string, changed: number, failed: number }>}
 */
async function runGroupSchedule(row, scanOnce) {
  const members = groupRepo.activeMembers(row.group_id);

  if (members.length === 0) {
    console.log(`⏱  Group "${row.group_name}" is scheduled but has no active websites`);
    return { status: 'empty', changed: 0, failed: 0 };
  }

  const results = [];
  for (const site of members) {
    const result = await scanOnce(site, row.period_days, 'group_schedule');
    results.push({
      name: site.name,
      url: site.url,
      status: result.status,
      changesFound: Boolean(result.changesFound),
      scanId: result.scanId ?? null,
      summary: result.llm_summary,
      error: result.error_message || result.error || null,
    });
  }

  const changed = results.filter((r) => r.changesFound).length;
  const failed = results.filter((r) => r.status === 'error').length;

  let status;
  if (failed === results.length) status = 'error';
  else if (failed > 0) status = 'partial';
  else if (changed > 0) status = 'completed';
  else status = 'no_changes';

  // 'changes' means changes *or failures*: a scan that failed is something the
  // recipients need to hear about, since it means the monitoring is not working.
  const notify = row.notify_on === 'always' || changed > 0 || failed > 0;
  if (notify) await notifyGroup(row, results);

  return { status, changed, failed };
}

async function notifyGroup(row, results) {
  const { recipients } = notifications.recipientsFor({
    ownerId: row.owner_id,
    groupEmails: groupRepo.parseList(row.notify_emails),
  });

  if (recipients.length === 0) {
    console.log(
      `📧 Group "${row.group_name}" finished, but there is nobody to tell — ` +
        'add recipients to the group or a default on the Schedules page'
    );
    return;
  }

  const message = emails.groupScanDigest({
    groupName: row.group_name,
    scheduleLabel: FREQUENCY_LABELS[row.frequency],
    results,
  });

  // One message per recipient: addresses are not shown to each other, and one
  // rejected address does not stop delivery to the rest.
  for (const to of recipients) {
    await mailer.send({ to, ...message });
  }
}

/**
 * A scan function for one tick that runs each website at most once per period.
 *
 * Failures come back as an error result rather than a throw, so one broken
 * site cannot stop a group run part-way through — and a failure is reported in
 * every schedule that wanted that site, not just the first.
 */
function scanOncePerTick() {
  const scans = new Map();

  return (website, periodDays, triggeredBy) => {
    const key = `${website.id}:${periodDays}`;
    if (!scans.has(key)) {
      scans.set(
        key,
        runSingleScan(website, periodDays, triggeredBy).catch((err) => {
          console.error(`Scheduled scan failed for ${website.url}:`, err.message);
          return {
            scanId: null,
            status: 'error',
            changesFound: false,
            error: err.message,
          };
        })
      );
    }
    return scans.get(key);
  };
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
    const dueGroups = groupScheduleRepo.claimDue(GROUP_BATCH_SIZE);
    if (due.length === 0 && dueGroups.length === 0) return { ran: 0, groups: 0 };

    console.log(
      `⏱  Running ${due.length} scheduled scan(s) and ${dueGroups.length} group run(s)`
    );

    const scanOnce = scanOncePerTick();

    for (const row of due) {
      let status;
      try {
        status = await runSchedule(row, scanOnce);
      } catch (err) {
        console.error(`Scheduled scan failed for ${row.url}:`, err.message);
        status = 'error';
      }
      scheduleRepo.markRun(row.id, status);
    }

    for (const row of dueGroups) {
      let outcome;
      try {
        outcome = await runGroupSchedule(row, scanOnce);
      } catch (err) {
        console.error(`Scheduled group run failed for "${row.group_name}":`, err.message);
        outcome = { status: 'error', changed: 0, failed: 0 };
      }
      groupScheduleRepo.markRun(row.id, outcome);
    }

    return { ran: due.length, groups: dueGroups.length };
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

  const retention = retentionDays();
  if (!retention) return;

  for (const user of users) {
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

module.exports = {
  start,
  stop,
  tick,
  pruneRetention,
  isEnabled,
  BATCH_SIZE,
  GROUP_BATCH_SIZE,
};
