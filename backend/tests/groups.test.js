/**
 * Website groups and notification settings, through the API.
 *
 * The group endpoints are thin, so most of what is pinned here is the edges:
 * a group saved with fewer sites than were picked, a removed website quietly
 * rejoining its old groups when re-added, and a recipient list that accepts the
 * `admin@local` placeholder alerts used to go to.
 */

const request = require('supertest');
const { createTestApp, signIn, ownerId, as } = require('./helpers');

let ctx;
let token;
let owner;

beforeAll(async () => {
  ctx = createTestApp();
  token = (await signIn(request, ctx.app)).token;
  owner = ownerId(ctx.db);
});

afterAll(() => ctx.cleanup());

const api = {
  get: (path) => as(request(ctx.app).get(path), token),
  post: (path, body) => as(request(ctx.app).post(path), token).send(body),
  patch: (path, body) => as(request(ctx.app).patch(path), token).send(body),
  put: (path, body) => as(request(ctx.app).put(path), token).send(body),
  del: (path) => as(request(ctx.app).delete(path), token),
};

let siteCounter = 0;
async function addSite(label = `site-${++siteCounter}`) {
  const res = await api.post('/api/websites', { url: `https://${label}.example.com/` });
  return res.body.id;
}

async function groups() {
  return (await api.get('/api/groups')).body.groups;
}

// ---------------------------------------------------------------------------

describe('creating and editing groups', () => {
  it('saves a named group with its websites', async () => {
    const a = await addSite();
    const b = await addSite();

    const res = await api.post('/api/groups', { name: '  Statutes  ', websiteIds: [a, b] });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Statutes'); // trimmed
    expect(res.body.website_ids.sort()).toEqual([a, b].sort());
    expect(res.body.member_count).toBe(2);
    expect(res.body.notify_on).toBe('changes');
    expect(res.body.schedule).toBeNull();
  });

  it('lists groups with the cadences a schedule may use', async () => {
    const res = await api.get('/api/groups');

    expect(res.status).toBe(200);
    expect(res.body.groups.map((g) => g.name)).toContain('Statutes');
    expect(res.body.allowedFrequencies).toEqual(['hourly', 'daily', 'weekly']);
  });

  it('requires a name', async () => {
    const res = await api.post('/api/groups', { name: '   ', websiteIds: [] });
    expect(res.status).toBe(400);
  });

  it('refuses a second group with the same name', async () => {
    const res = await api.post('/api/groups', { name: 'Statutes', websiteIds: [] });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Statutes');
  });

  it('refuses website ids it cannot find rather than saving fewer sites than were picked', async () => {
    const a = await addSite();

    const res = await api.post('/api/groups', { name: 'Gappy', websiteIds: [a, 999999] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('999999');
    expect((await groups()).map((g) => g.name)).not.toContain('Gappy');
  });

  it('refuses another account’s websites', async () => {
    const stranger = ctx.db
      .prepare(`INSERT INTO users (email, password_hash) VALUES ('s@example.com', 'x')`)
      .run().lastInsertRowid;
    const theirs = ctx.db
      .prepare(`INSERT INTO websites (owner_id, url) VALUES (?, 'https://theirs.example.com')`)
      .run(stranger).lastInsertRowid;

    const res = await api.post('/api/groups', { name: 'Grabby', websiteIds: [theirs] });

    expect(res.status).toBe(400);
  });

  it('changes only the fields a PATCH names', async () => {
    const a = await addSite();
    const b = await addSite();
    const created = (await api.post('/api/groups', {
      name: 'Editable',
      websiteIds: [a],
      notifyEmails: ['team@example.com'],
    })).body;

    const renamed = await api.patch(`/api/groups/${created.id}`, { name: 'Edited' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Edited');
    expect(renamed.body.website_ids).toEqual([a]);
    expect(renamed.body.notify_emails).toEqual(['team@example.com']);

    const regrouped = await api.patch(`/api/groups/${created.id}`, { websiteIds: [b] });
    expect(regrouped.body.website_ids).toEqual([b]);
    expect(regrouped.body.name).toBe('Edited');
  });

  it('may keep its own name on rename', async () => {
    const created = (await api.post('/api/groups', { name: 'Same', websiteIds: [] })).body;

    const res = await api.patch(`/api/groups/${created.id}`, { name: 'Same' });
    expect(res.status).toBe(200);
  });

  it('deletes the grouping only, never the websites', async () => {
    const a = await addSite();
    const created = (await api.post('/api/groups', { name: 'Doomed', websiteIds: [a] })).body;

    const res = await api.del(`/api/groups/${created.id}`);

    expect(res.status).toBe(200);
    expect((await groups()).map((g) => g.name)).not.toContain('Doomed');
    const site = ctx.db.prepare('SELECT is_active FROM websites WHERE id = ?').get(a);
    expect(site.is_active).toBe(1);
  });

  it('treats another account’s group as not found', async () => {
    const stranger = ctx.db
      .prepare(`INSERT INTO users (email, password_hash) VALUES ('t@example.com', 'x')`)
      .run().lastInsertRowid;
    const theirs = ctx.db
      .prepare(`INSERT INTO website_groups (owner_id, name) VALUES (?, 'Theirs')`)
      .run(stranger).lastInsertRowid;

    expect((await api.patch(`/api/groups/${theirs}`, { name: 'Mine now' })).status).toBe(404);
    expect((await api.del(`/api/groups/${theirs}`)).status).toBe(404);
    expect((await api.put(`/api/groups/${theirs}/schedule`, { frequency: 'daily' })).status).toBe(404);
    expect((await groups()).map((g) => g.name)).not.toContain('Theirs');
  });
});

describe('membership follows the websites', () => {
  it('drops a website from its groups when it is removed', async () => {
    const a = await addSite();
    const b = await addSite();
    const group = (await api.post('/api/groups', { name: 'Shrinks', websiteIds: [a, b] })).body;

    await api.del(`/api/websites/${a}`);

    const after = (await groups()).find((g) => g.id === group.id);
    expect(after.website_ids).toEqual([b]);
  });

  it('does not let a re-added website rejoin its old groups', async () => {
    // Re-adding a URL reactivates the same row and id. Without explicit cleanup
    // the old membership row would still be there and the site would silently
    // be back in the group.
    const a = await addSite('comeback');
    const group = (await api.post('/api/groups', { name: 'Comeback', websiteIds: [a] })).body;

    await api.del(`/api/websites/${a}`);
    const readded = await api.post('/api/websites', { url: 'https://comeback.example.com/' });
    expect(readded.body.id).toBe(a); // same row

    const after = (await groups()).find((g) => g.id === group.id);
    expect(after.website_ids).toEqual([]);
  });

  it('drops websites removed in bulk', async () => {
    const a = await addSite();
    const b = await addSite();
    const c = await addSite();
    const group = (await api.post('/api/groups', { name: 'Bulk', websiteIds: [a, b, c] })).body;

    await api.post('/api/websites/bulk-delete', { ids: [a, c] });

    const after = (await groups()).find((g) => g.id === group.id);
    expect(after.website_ids).toEqual([b]);
  });
});

describe('group schedules', () => {
  let group;

  beforeAll(async () => {
    const a = await addSite();
    group = (await api.post('/api/groups', { name: 'Scheduled', websiteIds: [a] })).body;
  });

  it('attaches a cadence and books the first run one interval out', async () => {
    const before = Date.now();
    const res = await api.put(`/api/groups/${group.id}/schedule`, {
      frequency: 'weekly',
      periodDays: 14,
    });

    expect(res.status).toBe(200);
    expect(res.body.schedule).toMatchObject({ frequency: 'weekly', period_days: 14, is_enabled: true });

    // Not "now": switching a schedule on must not spend a scan of every member.
    const next = new Date(res.body.schedule.next_run_at).getTime();
    expect(next - before).toBeGreaterThan(6 * 86_400_000);
  });

  it('keeps the next run when only the period changes', async () => {
    const before = (await groups()).find((g) => g.id === group.id).schedule.next_run_at;

    await api.put(`/api/groups/${group.id}/schedule`, { frequency: 'weekly', periodDays: 60 });

    const after = (await groups()).find((g) => g.id === group.id).schedule;
    expect(after.period_days).toBe(60);
    expect(after.next_run_at).toBe(before);
  });

  it('rejects an unknown cadence or an impossible period', async () => {
    expect((await api.put(`/api/groups/${group.id}/schedule`, { frequency: 'monthly' })).status)
      .toBe(400);
    expect(
      (await api.put(`/api/groups/${group.id}/schedule`, { frequency: 'daily', periodDays: 99999 }))
        .status
    ).toBe(400);
  });

  it('removes the schedule, and goes with the group when the group is deleted', async () => {
    expect((await api.del(`/api/groups/${group.id}/schedule`)).status).toBe(200);
    expect((await groups()).find((g) => g.id === group.id).schedule).toBeNull();
    expect((await api.del(`/api/groups/${group.id}/schedule`)).status).toBe(404);

    await api.put(`/api/groups/${group.id}/schedule`, { frequency: 'daily' });
    await api.del(`/api/groups/${group.id}`);

    const orphan = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM group_schedules WHERE group_id = ?')
      .get(group.id);
    expect(orphan.n).toBe(0);
  });
});

describe('recipients', () => {
  it('accepts a pasted list and normalises it', async () => {
    const res = await api.post('/api/groups', {
      name: 'Pasted',
      websiteIds: [],
      notifyEmails: 'Legal@Example.com, ops@example.com;\nlegal@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.notify_emails).toEqual(['legal@example.com', 'ops@example.com']);
  });

  it('names the address it cannot use', async () => {
    // `admin@local` is exactly the address every alert used to go to.
    const res = await api.post('/api/groups', {
      name: 'Bad address',
      websiteIds: [],
      notifyEmails: ['ok@example.com', 'admin@local'],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('admin@local');
  });

  it('accepts only the two notification modes', async () => {
    const res = await api.post('/api/groups', { name: 'Mode', websiteIds: [], notifyOn: 'never' });
    expect(res.status).toBe(400);
  });
});

describe('notification settings', () => {
  it('reports the account address as unusable when it is the placeholder', async () => {
    const res = await api.get('/api/settings/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      defaultEmails: [],
      smtpConfigured: false,
      accountEmail: 'admin@local',
      accountEmailUsable: false,
    });
  });

  it('saves a default list and rejects a bad one by name', async () => {
    const ok = await api.put('/api/settings/notifications', {
      defaultEmails: 'watch@example.com\nboss@example.com',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.defaultEmails).toEqual(['watch@example.com', 'boss@example.com']);

    const bad = await api.put('/api/settings/notifications', { defaultEmails: 'not-an-address' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('not-an-address');

    // The bad save did not clobber the good one.
    expect((await api.get('/api/settings/notifications')).body.defaultEmails)
      .toEqual(['watch@example.com', 'boss@example.com']);
  });

  it('says plainly when a test email cannot be sent because SMTP is not set up', async () => {
    const res = await api.post('/api/settings/notifications/test', {});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SMTP_NOT_CONFIGURED');
  });

  it('refuses a test with nobody to send it to', async () => {
    await api.put('/api/settings/notifications', { defaultEmails: [] });

    const res = await api.post('/api/settings/notifications/test', {});
    expect(res.status).toBe(400);
  });

  it('is not reachable without a session', async () => {
    expect((await request(ctx.app).get('/api/settings/notifications')).status).toBe(401);
    expect((await request(ctx.app).get('/api/groups')).status).toBe(401);
  });

  it('keeps the owner id in step', () => {
    // Guard against the suite drifting onto a different account mid-run.
    expect(ownerId(ctx.db)).toBe(owner);
  });
});

describe('sending a test email', () => {
  let mailCtx;
  let mailToken;
  const sent = [];

  beforeAll(async () => {
    // A separate app with SMTP "configured", and the transport replaced, so the
    // endpoint's success path runs without a mail server.
    ctx.cleanup();
    mailCtx = createTestApp({ SMTP_HOST: 'smtp.invalid' });
    const mailer = require('../src/services/mailer');
    mailer.send = async (message) => {
      sent.push(message);
      return message.to !== 'bounce@example.com';
    };
    mailToken = (await signIn(request, mailCtx.app)).token;
  });

  afterAll(() => {
    mailCtx.cleanup();
    delete process.env.SMTP_HOST;
    // Leave a live app behind for the outer afterAll's cleanup().
    ctx = createTestApp();
  });

  it('sends one message per address and reports each', async () => {
    const res = await as(request(mailCtx.app).post('/api/settings/notifications/test'), mailToken)
      .send({ emails: ['a@example.com', 'bounce@example.com'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { to: 'a@example.com', sent: true },
      { to: 'bounce@example.com', sent: false },
    ]);
    expect(res.body.allSent).toBe(false);
    expect(sent.map((m) => m.to)).toEqual(['a@example.com', 'bounce@example.com']);
    expect(sent[0].subject).toMatch(/test/i);
  });
});
