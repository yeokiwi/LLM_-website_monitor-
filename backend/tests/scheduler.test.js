/**
 * The scheduler.
 *
 * A scan costs real money, so the property that matters most is that an
 * interrupted tick skips its run rather than repeating it. That works because
 * `claimDue` advances `next_run_at` inside the same transaction that reads the
 * due rows — these tests pin that, plus the schedule lifecycle.
 */

const request = require('supertest');
const { createTestApp, signIn, as } = require('./helpers');

describe('scheduler', () => {
  let ctx;
  let scheduleRepo;

  beforeAll(() => {
    ctx = createTestApp();
    scheduleRepo = require('../src/repositories/scheduleRepo');
  });

  afterAll(() => ctx.cleanup());

  /** Add a website with a schedule that is already due. */
  async function makeDueSchedule(name, frequency = 'daily') {
    const account = await signIn(request, ctx.app);

    const site = (
      await as(request(ctx.app).post('/api/websites'), account.token)
        .send({ url: `https://${name}.example.com` })
    ).body;

    await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
      .send({ frequency });

    ctx.db
      .prepare('UPDATE schedules SET next_run_at = ? WHERE website_id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), site.id);

    return { account, site };
  }

  describe('claiming due work', () => {
    it('returns a schedule whose time has come', async () => {
      const { site } = await makeDueSchedule('due');

      const claimed = scheduleRepo.claimDue(10);
      expect(claimed.map((r) => r.website_id)).toContain(site.id);
    });

    it('does not return it again, because claiming advances the next run', () => {
      const claimed = scheduleRepo.claimDue(10);
      expect(claimed).toHaveLength(0);
    });

    it('books the next slot at the moment of claiming, so a crash skips rather than repeats', async () => {
      const { site } = await makeDueSchedule('crash');

      const before = ctx.db
        .prepare('SELECT next_run_at FROM schedules WHERE website_id = ?')
        .get(site.id).next_run_at;

      scheduleRepo.claimDue(10);

      const after = ctx.db
        .prepare('SELECT next_run_at FROM schedules WHERE website_id = ?')
        .get(site.id).next_run_at;

      expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
      // A daily schedule lands roughly a day out.
      expect(Date.parse(after) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    });

    it('ignores a disabled schedule', async () => {
      const { site } = await makeDueSchedule('disabled');
      ctx.db.prepare('UPDATE schedules SET is_enabled = 0 WHERE website_id = ?').run(site.id);

      const claimed = scheduleRepo.claimDue(10);
      expect(claimed.map((r) => r.website_id)).not.toContain(site.id);
    });

    it('ignores a schedule whose website has been removed', async () => {
      const { account, site } = await makeDueSchedule('removed');
      // Deactivate directly: deleting through the API also drops the schedule.
      ctx.db.prepare('UPDATE websites SET is_active = 0 WHERE id = ?').run(site.id);

      const claimed = scheduleRepo.claimDue(10);
      expect(claimed.map((r) => r.website_id)).not.toContain(site.id);
      expect(account).toBeTruthy();
    });

    it('does not claim a schedule that is not due yet', async () => {
      const account = await signIn(request, ctx.app);

      const site = (
        await as(request(ctx.app).post('/api/websites'), account.token)
          .send({ url: 'https://future.example.com' })
      ).body;

      await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
        .send({ frequency: 'daily' });

      const claimed = scheduleRepo.claimDue(10);
      expect(claimed.map((r) => r.website_id)).not.toContain(site.id);
    });

    it('respects the batch size so one tick stays bounded', async () => {
      for (let i = 0; i < 4; i++) {
        await makeDueSchedule(`batch-${i}`);
      }

      const claimed = scheduleRepo.claimDue(2);
      expect(claimed).toHaveLength(2);
    });
  });

  describe('schedule lifecycle', () => {
    it('does not fire immediately when a schedule is created', async () => {
      const account = await signIn(request, ctx.app);

      const site = (
        await as(request(ctx.app).post('/api/websites'), account.token)
          .send({ url: 'https://nofire.example.com' })
      ).body;

      const res = await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
        .send({ frequency: 'daily' });

      // Turning a schedule on should not spend a scan on the spot.
      expect(Date.parse(res.body.next_run_at)).toBeGreaterThan(Date.now());
    });

    it('keeps the existing next run when only the period changes', async () => {
      const account = await signIn(request, ctx.app);

      const site = (
        await as(request(ctx.app).post('/api/websites'), account.token)
          .send({ url: 'https://reanchor.example.com' })
      ).body;

      const first = await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
        .send({ frequency: 'daily', periodDays: 30 });

      const second = await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
        .send({ frequency: 'daily', periodDays: 60 });

      expect(second.body.next_run_at).toBe(first.body.next_run_at);
      expect(second.body.period_days).toBe(60);
    });

    it('re-anchors the next run when the cadence changes', async () => {
      const account = await signIn(request, ctx.app);

      const site = (
        await as(request(ctx.app).post('/api/websites'), account.token)
          .send({ url: 'https://cadence.example.com' })
      ).body;

      const weekly = await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
        .send({ frequency: 'weekly' });

      const hourly = await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
        .send({ frequency: 'hourly' });

      expect(Date.parse(hourly.body.next_run_at)).toBeLessThan(Date.parse(weekly.body.next_run_at));
    });

    it('removes the schedule when its website is deleted', async () => {
      const account = await signIn(request, ctx.app);

      const site = (
        await as(request(ctx.app).post('/api/websites'), account.token)
          .send({ url: 'https://cascade.example.com' })
      ).body;

      await as(request(ctx.app).put(`/api/schedules/${site.id}`), account.token)
        .send({ frequency: 'daily' });

      await as(request(ctx.app).delete(`/api/websites/${site.id}`), account.token);

      const left = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM schedules WHERE website_id = ?')
        .get(site.id);
      expect(left.n).toBe(0);
    });
  });

  describe('configuration', () => {
    it('is off by default outside production', () => {
      const scheduler = require('../src/services/scheduler');
      expect(scheduler.isEnabled()).toBe(false);
    });
  });
});
