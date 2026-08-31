/**
 * Plan enforcement.
 *
 * Every scan costs real money (a scrape plus an LLM completion), so the
 * quota checks are the difference between a subscription business and an
 * unbounded bill.
 */

const request = require('supertest');
const { createTestApp, signup, as, grantPlan } = require('./helpers');

describe('entitlements', () => {
  let ctx;

  beforeAll(() => { ctx = createTestApp(); });
  afterAll(() => ctx.cleanup());

  const addSite = (token, url) =>
    as(request(ctx.app).post('/api/websites'), token).send({ url });

  describe('website quota', () => {
    let user;

    beforeAll(async () => { user = await signup(request, ctx.app, 'sites@example.com'); });

    it('allows exactly the plan’s allowance', async () => {
      for (let i = 1; i <= 3; i++) {
        const res = await addSite(user.token, `https://site-${i}.example.com`);
        expect(res.status).toBe(201);
      }
    });

    it('refuses the next one with a 402 and an upgrade hint', async () => {
      const res = await addSite(user.token, 'https://site-4.example.com');

      expect(res.status).toBe(402);
      expect(res.body.code).toBe('QUOTA_EXCEEDED');
      expect(res.body.quota).toBe('websites');
      expect(res.body.limit).toBe(3);
      expect(res.body.upgradeTo.slug).toBe('pro');
    });

    it('checks a bulk import up front rather than filling to the wall', async () => {
      const fresh = await signup(request, ctx.app, 'bulk@example.com');

      const res = await as(request(ctx.app).post('/api/websites/bulk'), fresh.token)
        .send({ websites: Array.from({ length: 10 }, (_, i) => ({ url: `https://b${i}.example.com` })) });

      expect(res.status).toBe(402);

      // Nothing was inserted — a rejected batch must not partially apply.
      const list = await as(request(ctx.app).get('/api/websites'), fresh.token);
      expect(list.body).toHaveLength(0);
    });

    it('frees a slot when a website is removed', async () => {
      const list = await as(request(ctx.app).get('/api/websites'), user.token);
      await as(request(ctx.app).delete(`/api/websites/${list.body[0].id}`), user.token);

      const res = await addSite(user.token, 'https://replacement.example.com');
      expect(res.status).toBe(201);
    });

    it('lifts the wall on a bigger plan', async () => {
      const pro = await signup(request, ctx.app, 'pro-sites@example.com');
      grantPlan(ctx.db, pro.user.id, 'pro');

      for (let i = 1; i <= 5; i++) {
        const res = await addSite(pro.token, `https://pro-${i}.example.com`);
        expect(res.status).toBe(201);
      }

      const me = await as(request(ctx.app).get('/api/auth/me'), pro.token);
      expect(me.body.usage.websites.limit).toBe(25);
    });
  });

  describe('scan quota', () => {
    let user;

    beforeAll(async () => {
      user = await signup(request, ctx.app, 'scans@example.com');
      await addSite(user.token, 'https://scan-me.example.com');
    });

    it('refuses a batch larger than the remaining allowance, before spending any', async () => {
      const usageRepo = require('../src/repositories/usageRepo');
      const window = usageRepo.currentWindow(null);
      usageRepo.increment(user.user.id, window, { scans_used: 9 });

      const list = await as(request(ctx.app).get('/api/websites'), user.token);
      const ids = list.body.map((w) => w.id);

      const res = await as(request(ctx.app).post('/api/scans'), user.token)
        .send({ websiteIds: [...ids, ...ids], periodDays: 30 });

      expect(res.status).toBe(402);
      expect(res.body.quota).toBe('scans');
      expect(res.body.remaining).toBe(1);
    });

    it('refuses any scan once the allowance is gone', async () => {
      const usageRepo = require('../src/repositories/usageRepo');
      const window = usageRepo.currentWindow(null);
      usageRepo.increment(user.user.id, window, { scans_used: 1 });

      const list = await as(request(ctx.app).get('/api/websites'), user.token);
      const res = await as(request(ctx.app).post('/api/scans'), user.token)
        .send({ websiteIds: [list.body[0].id], periodDays: 30 });

      expect(res.status).toBe(402);
      expect(res.body.remaining).toBe(0);
    });

    it('reports usage back to the client', async () => {
      const me = await as(request(ctx.app).get('/api/auth/me'), user.token);
      expect(me.body.usage.scans.used).toBe(10);
      expect(me.body.usage.scans.limit).toBe(10);
      expect(me.body.usage.scans.remaining).toBe(0);
    });
  });

  describe('feature gates', () => {
    let free;
    let pro;
    let business;

    beforeAll(async () => {
      free = await signup(request, ctx.app, 'free-features@example.com');
      pro = await signup(request, ctx.app, 'pro-features@example.com');
      business = await signup(request, ctx.app, 'business-features@example.com');
      grantPlan(ctx.db, pro.user.id, 'pro');
      grantPlan(ctx.db, business.user.id, 'business');
    });

    it('locks PDF export on Free and unlocks it on Pro', async () => {
      const locked = await as(request(ctx.app).get('/api/scans/export-pdf'), free.token);
      expect(locked.status).toBe(402);
      expect(locked.body.feature).toBe('pdf_export');
      expect(locked.body.upgradeTo.slug).toBe('pro');

      const unlocked = await as(request(ctx.app).get('/api/scans/export-pdf'), pro.token);
      expect(unlocked.status).toBe(200);
    });

    it('reserves spreadsheet import/export for Business', async () => {
      for (const account of [free, pro]) {
        const res = await as(request(ctx.app).get('/api/websites/export'), account.token);
        expect(res.status).toBe(402);
        expect(res.body.upgradeTo.slug).toBe('business');
      }

      const allowed = await as(request(ctx.app).get('/api/websites/export'), business.token);
      expect(allowed.status).toBe(200);
    });

    it('reserves the personal data export for Business', async () => {
      const locked = await as(request(ctx.app).get('/api/database/my-data'), pro.token);
      expect(locked.status).toBe(402);

      const allowed = await as(request(ctx.app).get('/api/database/my-data'), business.token);
      expect(allowed.status).toBe(200);
    });
  });

  describe('scheduling', () => {
    let free;
    let pro;
    let business;
    let freeSite;
    let proSite;
    let businessSite;

    beforeAll(async () => {
      free = await signup(request, ctx.app, 'free-sched@example.com');
      pro = await signup(request, ctx.app, 'pro-sched@example.com');
      business = await signup(request, ctx.app, 'biz-sched@example.com');
      grantPlan(ctx.db, pro.user.id, 'pro');
      grantPlan(ctx.db, business.user.id, 'business');

      freeSite = (await addSite(free.token, 'https://f.example.com')).body;
      proSite = (await addSite(pro.token, 'https://p.example.com')).body;
      businessSite = (await addSite(business.token, 'https://b.example.com')).body;
    });

    it('refuses any schedule on Free', async () => {
      const res = await as(request(ctx.app).put(`/api/schedules/${freeSite.id}`), free.token)
        .send({ frequency: 'daily' });

      expect(res.status).toBe(402);
      expect(res.body.allowedFrequencies).toEqual([]);
    });

    it('allows daily on Pro but not hourly', async () => {
      const daily = await as(request(ctx.app).put(`/api/schedules/${proSite.id}`), pro.token)
        .send({ frequency: 'daily' });
      expect(daily.status).toBe(200);
      expect(daily.body.next_run_at).toBeTruthy();

      const hourly = await as(request(ctx.app).put(`/api/schedules/${proSite.id}`), pro.token)
        .send({ frequency: 'hourly' });
      expect(hourly.status).toBe(402);
      expect(hourly.body.upgradeTo.slug).toBe('business');
    });

    it('allows hourly on Business', async () => {
      const res = await as(
        request(ctx.app).put(`/api/schedules/${businessSite.id}`),
        business.token
      ).send({ frequency: 'hourly' });

      expect(res.status).toBe(200);
    });

    it('refuses a schedule on another tenant’s website', async () => {
      const res = await as(request(ctx.app).put(`/api/schedules/${proSite.id}`), business.token)
        .send({ frequency: 'daily' });

      expect(res.status).toBe(404);
    });
  });

  describe('engine gating', () => {
    it('downgrades a Free account to a direct scrape instead of spending on premium engines', async () => {
      const free = await signup(request, ctx.app, 'engines@example.com');
      const site = (await addSite(free.token, 'https://engines.example.com')).body;

      // Keys present and the website opted into every engine.
      process.env.FIRECRAWL_API_KEY = 'test-key';
      process.env.BRAVE_API_KEY = 'test-key';
      process.env.SERPER_API_KEY = 'test-key';

      const { resolveProviders } = require('../src/services/scanService');
      const resolved = resolveProviders(
        { ...site, use_firecrawl: 1, use_brave: 1, use_serper: 1 },
        free.user.id
      );

      expect(resolved.providers).toEqual(['direct']);
      expect(resolved.usingFallback).toBe(true);
    });

    it('uses the premium engines a paid plan includes', async () => {
      const pro = await signup(request, ctx.app, 'pro-engines@example.com');
      grantPlan(ctx.db, pro.user.id, 'pro');
      const site = (await addSite(pro.token, 'https://pro-engines.example.com')).body;

      const { resolveProviders } = require('../src/services/scanService');
      const resolved = resolveProviders(
        { ...site, use_firecrawl: 1, use_brave: 1, use_serper: 1 },
        pro.user.id
      );

      expect(resolved.providers).toEqual(['firecrawl', 'brave', 'serper']);
    });

    it('never selects an engine the deployment has no key for', async () => {
      delete process.env.FIRECRAWL_API_KEY;
      delete process.env.BRAVE_API_KEY;
      delete process.env.SERPER_API_KEY;

      const pro = await signup(request, ctx.app, 'nokeys@example.com');
      grantPlan(ctx.db, pro.user.id, 'pro');
      const site = (await addSite(pro.token, 'https://nokeys.example.com')).body;

      const { resolveProviders } = require('../src/services/scanService');
      const resolved = resolveProviders(
        { ...site, use_firecrawl: 1, use_brave: 1, use_serper: 1 },
        pro.user.id
      );

      expect(resolved.providers).toEqual(['direct']);
    });
  });

  describe('grace period', () => {
    it('keeps a past_due subscriber entitled during the grace window', async () => {
      const user = await signup(request, ctx.app, 'pastdue@example.com');
      grantPlan(ctx.db, user.user.id, 'pro', 'past_due');
      ctx.db
        .prepare('UPDATE subscriptions SET past_due_since = ? WHERE user_id = ?')
        .run(new Date().toISOString(), user.user.id);

      const me = await as(request(ctx.app).get('/api/auth/me'), user.token);
      expect(me.body.plan.slug).toBe('pro');
      expect(me.body.subscription.in_grace_period).toBe(true);
    });

    it('drops to Free once the grace window has elapsed', async () => {
      const user = await signup(request, ctx.app, 'lapsed@example.com');
      grantPlan(ctx.db, user.user.id, 'pro', 'past_due');
      ctx.db
        .prepare('UPDATE subscriptions SET past_due_since = ? WHERE user_id = ?')
        .run(new Date(Date.now() - 30 * 86_400_000).toISOString(), user.user.id);

      const me = await as(request(ctx.app).get('/api/auth/me'), user.token);
      expect(me.body.plan.slug).toBe('free');
    });

    it('drops a cancelled subscriber to Free', async () => {
      const user = await signup(request, ctx.app, 'cancelled@example.com');
      grantPlan(ctx.db, user.user.id, 'pro', 'canceled');

      const me = await as(request(ctx.app).get('/api/auth/me'), user.token);
      expect(me.body.plan.slug).toBe('free');
    });
  });
});
