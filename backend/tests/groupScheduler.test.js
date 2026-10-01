/**
 * Scheduled group runs, end to end through `scheduler.tick()`.
 *
 * Until now no test called `tick()` and none touched the mailer, so the
 * scheduled path — the one that runs unattended and spends money — had never
 * been exercised. These tests drive real ticks against a real database with
 * only the outside world replaced: the scraper, the LLM and the mail transport.
 *
 * The stubs are installed on the module objects before scanService and the
 * scheduler are loaded, because both destructure at require time — the same
 * arrangement as scanService.test.js.
 */

const { createTestApp, ownerId: seededOwnerId, resetModules } = require('./helpers');

let harness;
let db;
let scheduler;
let scanService;
let notifications;
let owner;

/** url -> page text, or an Error to make that site's scrape fail. */
const pages = {};
/** url -> how many times it was scraped. */
const scrapes = {};
/** Every message handed to the mail transport. */
let sent = [];

beforeAll(() => {
  // Only the direct engine: a key leaked into the environment by another suite
  // would add engines and multiply the scrape counts asserted below.
  for (const key of ['FIRECRAWL_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY']) {
    delete process.env[key];
  }

  harness = createTestApp();
  owner = seededOwnerId(harness.db);
  harness.db.close();

  resetModules();
  const scraper = require('../src/services/scraper');
  const llmService = require('../src/services/llmService');
  const mailer = require('../src/services/mailer');

  scraper.isPdfUrl = async () => false;
  scraper.scrapeWithProvider = async (provider, url) => {
    scrapes[url] = (scrapes[url] || 0) + 1;
    const page = pages[url];
    if (page instanceof Error) throw page;
    if (page === undefined) throw new Error(`no page configured for ${url}`);
    return { contentText: page, source: provider, pages: [], notes: [] };
  };
  llmService.summarizeChanges = async ({ websiteUrl }) => ({
    markdown: `## Executive Summary\n\nSomething moved on ${websiteUrl}.`,
    usage: { inputTokens: 1, outputTokens: 1, model: 'stub' },
  });
  mailer.send = async (message) => {
    sent.push(message);
    return true;
  };

  db = require('../src/db');
  scanService = require('../src/services/scanService');
  notifications = require('../src/services/notifications');
  scheduler = require('../src/services/scheduler');
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  harness.cleanup();
});

beforeEach(() => {
  sent = [];
  for (const url of Object.keys(scrapes)) delete scrapes[url];
  notifications.setDefaultEmails([]);
  db.prepare("UPDATE users SET email = 'admin@local' WHERE id = ?").run(owner);
});

// ---------------------------------------------------------------------------
// Fixtures — plain SQL, so the tests read as the state they set up.
// ---------------------------------------------------------------------------

let siteCounter = 0;

function addSite(content, { active = true } = {}) {
  const n = ++siteCounter;
  const url = `https://site-${n}.example.com/page`;
  pages[url] = content;
  const id = db
    .prepare(
      `INSERT INTO websites (owner_id, url, name, is_active, use_firecrawl, use_brave, use_serper)
       VALUES (?, ?, ?, ?, 0, 0, 0)`
    )
    .run(owner, url, `Site ${n}`, active ? 1 : 0).lastInsertRowid;
  return { id, url, name: `Site ${n}` };
}

let groupCounter = 0;

function addGroup(sites, { emails = [], notifyOn = 'changes', period = 30, frequency = 'daily' } = {}) {
  const name = `Group ${++groupCounter}`;
  const groupId = db
    .prepare(
      `INSERT INTO website_groups (owner_id, name, notify_emails, notify_on)
       VALUES (?, ?, ?, ?)`
    )
    .run(owner, name, JSON.stringify(emails), notifyOn).lastInsertRowid;

  const member = db.prepare(
    'INSERT INTO website_group_members (group_id, website_id) VALUES (?, ?)'
  );
  for (const site of sites) member.run(groupId, site.id);

  db.prepare(
    `INSERT INTO group_schedules (group_id, owner_id, frequency, period_days, next_run_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(groupId, owner, frequency, period, past());

  return { id: groupId, name };
}

const past = () => new Date(Date.now() - 60_000).toISOString();

function makeDue(groupId) {
  db.prepare('UPDATE group_schedules SET next_run_at = ? WHERE group_id = ?').run(past(), groupId);
}

function scheduleRow(groupId) {
  return db.prepare('SELECT * FROM group_schedules WHERE group_id = ?').get(groupId);
}

/** Give a site a baseline, so the next differing scrape reads as a change. */
async function baseline(site) {
  await scanService.runSingleScan({ ...site, owner_id: owner }, 30, 'manual');
}

// ---------------------------------------------------------------------------

describe('a scheduled group run', () => {
  it('scans every active member once, with the group period, and books the next run', async () => {
    const a = addSite('alpha');
    const b = addSite('beta');
    const gone = addSite('removed', { active: false });
    const group = addGroup([a, b, gone], { period: 14 });

    const result = await scheduler.tick();

    expect(result.groups).toBe(1);
    expect(scrapes[a.url]).toBe(1);
    expect(scrapes[b.url]).toBe(1);
    expect(scrapes[gone.url]).toBeUndefined();

    const rows = db
      .prepare(
        `SELECT website_id, period_days, triggered_by FROM scan_results
          WHERE website_id IN (?, ?) ORDER BY website_id`
      )
      .all(a.id, b.id);
    expect(rows).toEqual([
      { website_id: a.id, period_days: 14, triggered_by: 'group_schedule' },
      { website_id: b.id, period_days: 14, triggered_by: 'group_schedule' },
    ]);

    const schedule = scheduleRow(group.id);
    expect(new Date(schedule.next_run_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(schedule.last_status).toBe('no_changes');
    expect(schedule.last_run_at).not.toBeNull();
  });

  it('does nothing on the very next tick, because claiming booked the next slot', async () => {
    const result = await scheduler.tick();

    expect(result).toEqual({ ran: 0, groups: 0 });
    expect(Object.keys(scrapes)).toHaveLength(0);
  });

  it('sends one digest to each of the group’s recipients when a member changed', async () => {
    const a = addSite('version one');
    await baseline(a);
    pages[a.url] = 'version two';
    const group = addGroup([a], { emails: ['legal@example.com', 'ops@example.com'] });

    await scheduler.tick();

    expect(sent.map((m) => m.to)).toEqual(['legal@example.com', 'ops@example.com']);
    expect(sent[0].subject).toBe(`${group.name}: 1 changed of 1 site`);
    expect(sent[1].subject).toBe(sent[0].subject);

    const scan = db
      .prepare('SELECT id FROM scan_results WHERE website_id = ? ORDER BY id DESC')
      .get(a.id);
    expect(sent[0].html).toContain(`/report/${scan.id}`);
    expect(sent[0].html).toContain(`Something moved on ${a.url}`);

    const schedule = scheduleRow(group.id);
    expect(schedule).toMatchObject({ last_status: 'completed', last_changed: 1, last_failed: 0 });
  });

  it('stays quiet under "changes" when nothing changed', async () => {
    const a = addSite('steady');
    await baseline(a);
    addGroup([a], { emails: ['legal@example.com'], notifyOn: 'changes' });

    await scheduler.tick();

    expect(sent).toHaveLength(0);
  });

  it('reports a failure under "changes" — a broken scan means monitoring is down', async () => {
    const broken = addSite(new Error('connect ETIMEDOUT'));
    const group = addGroup([broken], { emails: ['legal@example.com'] });

    await scheduler.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(`${group.name}: 1 failed of 1 site`);
    expect(sent[0].html).toContain('ETIMEDOUT');
    expect(scheduleRow(group.id)).toMatchObject({ last_status: 'error', last_failed: 1 });
  });

  it('emails on a quiet run under "always"', async () => {
    const a = addSite('unchanging');
    await baseline(a);
    const group = addGroup([a], { emails: ['legal@example.com'], notifyOn: 'always' });

    await scheduler.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(`${group.name}: no changes across 1 site`);
  });

  it('keeps going when one member fails, and records the run as partial', async () => {
    const broken = addSite(new Error('HTTP 503'));
    const fine = addSite('fine');
    const group = addGroup([broken, fine], { emails: ['legal@example.com'] });

    await scheduler.tick();

    expect(scrapes[fine.url]).toBe(1);
    expect(scheduleRow(group.id)).toMatchObject({
      last_status: 'partial',
      last_changed: 0,
      last_failed: 1,
    });
    // The digest names both sites, failure first.
    const html = sent[0].html;
    expect(html.indexOf(broken.url)).toBeLessThan(html.indexOf(fine.url));
  });

  it('records an empty group and sends nothing', async () => {
    const gone = addSite('removed', { active: false });
    const group = addGroup([gone], { emails: ['legal@example.com'], notifyOn: 'always' });

    await scheduler.tick();

    expect(scheduleRow(group.id).last_status).toBe('empty');
    expect(sent).toHaveLength(0);
    expect(scrapes[gone.url]).toBeUndefined();
  });
});

describe('paying for a site once per tick', () => {
  it('scrapes a site shared by two due groups once, and reports it in both', async () => {
    const shared = addSite('shared page');
    addGroup([shared], { emails: ['one@example.com'], notifyOn: 'always' });
    addGroup([shared], { emails: ['two@example.com'], notifyOn: 'always' });

    await scheduler.tick();

    expect(scrapes[shared.url]).toBe(1);
    expect(sent.map((m) => m.to).sort()).toEqual(['one@example.com', 'two@example.com']);
    for (const message of sent) expect(message.html).toContain(shared.url);

    const scans = db
      .prepare('SELECT COUNT(*) AS n FROM scan_results WHERE website_id = ?')
      .get(shared.id);
    expect(scans.n).toBe(1);
  });

  it('scans again for a different period — that is a different report', async () => {
    const shared = addSite('shared page, two periods');
    addGroup([shared], { period: 30 });
    addGroup([shared], { period: 90 });

    await scheduler.tick();

    expect(scrapes[shared.url]).toBe(2);
  });
});

describe('who gets told', () => {
  it('falls back to the default list when the group has none', async () => {
    notifications.setDefaultEmails(['watch@example.com']);
    addGroup([addSite('x')], { notifyOn: 'always' });

    await scheduler.tick();

    expect(sent.map((m) => m.to)).toEqual(['watch@example.com']);
  });

  it('prefers the group’s own list to the default', async () => {
    notifications.setDefaultEmails(['watch@example.com']);
    addGroup([addSite('y')], { emails: ['team@example.com'], notifyOn: 'always' });

    await scheduler.tick();

    expect(sent.map((m) => m.to)).toEqual(['team@example.com']);
  });

  it('never mails the admin@local placeholder', async () => {
    // This is what every alert used to do: hand mail to an address that cannot
    // receive it, with nothing reporting the problem.
    const group = addGroup([addSite('z')], { notifyOn: 'always' });

    await scheduler.tick();

    expect(sent).toHaveLength(0);
    // The run itself still happened and was recorded.
    expect(scheduleRow(group.id).last_status).toBe('no_changes');
  });

  it('uses the account address when it is a real one and nothing else is set', async () => {
    db.prepare("UPDATE users SET email = 'owner@example.com' WHERE id = ?").run(owner);
    addGroup([addSite('w')], { notifyOn: 'always' });

    await scheduler.tick();

    expect(sent.map((m) => m.to)).toEqual(['owner@example.com']);
  });

  it('sends a single website’s change alert to the default list', async () => {
    notifications.setDefaultEmails(['watch@example.com', 'boss@example.com']);
    const site = addSite('solo one');
    await baseline(site);
    pages[site.url] = 'solo two';
    db.prepare(
      `INSERT INTO schedules (website_id, owner_id, frequency, next_run_at)
       VALUES (?, ?, 'daily', ?)`
    ).run(site.id, owner, past());

    await scheduler.tick();

    expect(sent.map((m) => m.to)).toEqual(['watch@example.com', 'boss@example.com']);
    expect(sent[0].subject).toContain('Changes detected');
  });
});

describe('the overlap guard', () => {
  it('skips a tick while the previous one is still running', async () => {
    const slow = addSite('slow');
    const group = addGroup([slow], { notifyOn: 'always' });

    const first = scheduler.tick();
    const second = await scheduler.tick();
    await first;

    expect(second).toEqual({ skipped: true });
    expect(scrapes[slow.url]).toBe(1);
    expect(scheduleRow(group.id).last_status).not.toBeNull();
  });

  it('runs a group again once it is due again', async () => {
    const site = addSite('again');
    const group = addGroup([site], { notifyOn: 'always' });

    await scheduler.tick();
    makeDue(group.id);
    await scheduler.tick();

    expect(scrapes[site.url]).toBe(2);
  });
});
