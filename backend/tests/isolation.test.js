/**
 * Tenant isolation.
 *
 * This is the highest-consequence property in the codebase: before this work
 * every row was global, so a regression here leaks one customer's data to
 * another. These tests assert it from the outside, through the HTTP API,
 * because that is the boundary an attacker actually reaches.
 */

// describe/it/expect come from vitest's globals (see vitest.config.mjs).
const request = require('supertest');
const { createTestApp, signup, as, grantPlan } = require('./helpers');

describe('tenant isolation', () => {
  let ctx;
  let alice;
  let bob;
  let aliceSite;
  let bobSite;

  beforeAll(async () => {
    ctx = createTestApp();

    alice = await signup(request, ctx.app, 'alice@example.com');
    bob = await signup(request, ctx.app, 'bob@example.com');

    // Both need paid plans for the feature-gated endpoints below.
    grantPlan(ctx.db, alice.user.id, 'business');
    grantPlan(ctx.db, bob.user.id, 'business');

    aliceSite = (
      await as(request(ctx.app).post('/api/websites'), alice.token)
        .send({ url: 'https://example.com/news', name: "Alice's site" })
    ).body;

    bobSite = (
      await as(request(ctx.app).post('/api/websites'), bob.token)
        .send({ url: 'https://example.com/news', name: "Bob's site" })
    ).body;
  });

  afterAll(() => ctx.cleanup());

  it('lets two accounts monitor the same URL', () => {
    expect(aliceSite.id).toBeDefined();
    expect(bobSite.id).toBeDefined();
    expect(aliceSite.id).not.toBe(bobSite.id);
    expect(aliceSite.url).toBe(bobSite.url);
  });

  it('lists only the caller’s websites', async () => {
    const forAlice = await as(request(ctx.app).get('/api/websites'), alice.token);
    const forBob = await as(request(ctx.app).get('/api/websites'), bob.token);

    expect(forAlice.body).toHaveLength(1);
    expect(forBob.body).toHaveLength(1);
    expect(forAlice.body[0].name).toBe("Alice's site");
    expect(forBob.body[0].name).toBe("Bob's site");
  });

  it('404s a cross-tenant website read rather than 403', async () => {
    const res = await as(request(ctx.app).get(`/api/websites/${bobSite.id}`), alice.token);
    // 403 would confirm the row exists; 404 leaks nothing.
    expect(res.status).toBe(404);
  });

  it('refuses a cross-tenant update', async () => {
    const res = await as(
      request(ctx.app).patch(`/api/websites/${bobSite.id}`),
      alice.token
    ).send({ remark: 'tampered' });

    expect(res.status).toBe(404);

    const check = await as(request(ctx.app).get(`/api/websites/${bobSite.id}`), bob.token);
    expect(check.body.remark).toBeFalsy();
  });

  it('refuses a cross-tenant delete', async () => {
    const res = await as(
      request(ctx.app).delete(`/api/websites/${bobSite.id}`),
      alice.token
    );
    expect(res.status).toBe(404);

    const stillThere = await as(request(ctx.app).get('/api/websites'), bob.token);
    expect(stillThere.body).toHaveLength(1);
  });

  it('refuses a cross-tenant bulk delete', async () => {
    const res = await as(request(ctx.app).post('/api/websites/bulk-delete'), alice.token)
      .send({ ids: [bobSite.id] });

    expect(res.body.removed).toBe(0);

    const stillThere = await as(request(ctx.app).get('/api/websites'), bob.token);
    expect(stillThere.body).toHaveLength(1);
  });

  it('scopes bulk-update to the caller when no ids are given', async () => {
    // The previous implementation updated every active website in the database.
    await as(request(ctx.app).post('/api/websites/bulk-update'), alice.token)
      .send({ updates: { use_brave: 0 } });

    const bobsView = await as(request(ctx.app).get('/api/websites'), bob.token);
    expect(bobsView.body[0].use_brave).toBe(1);
  });

  it('refuses to scan another tenant’s website', async () => {
    const res = await as(request(ctx.app).post('/api/scans'), alice.token)
      .send({ websiteIds: [bobSite.id], periodDays: 30 });

    expect(res.status).toBe(404);
  });

  describe('scan history', () => {
    beforeAll(() => {
      // Insert scan rows directly: a real scan would hit the network and an LLM.
      const insert = (websiteId, ownerId, summary) => {
        const snapshot = ctx.db
          .prepare(
            `INSERT INTO snapshots (website_id, content_text, content_hash, provider)
             VALUES (?, 'text', 'hash', 'direct')`
          )
          .run(websiteId);

        ctx.db
          .prepare(
            `INSERT INTO scan_results (website_id, owner_id, period_days,
                                       new_snapshot_id, llm_summary, status)
             VALUES (?, ?, 30, ?, ?, 'completed')`
          )
          .run(websiteId, ownerId, snapshot.lastInsertRowid, summary);
      };

      insert(aliceSite.id, alice.user.id, "Alice's confidential report");
      insert(bobSite.id, bob.user.id, "Bob's confidential report");
    });

    it('lists only the caller’s scans', async () => {
      const res = await as(request(ctx.app).get('/api/scans'), alice.token);
      expect(res.body.total).toBe(1);
      expect(res.body.results[0].llm_summary).toContain('Alice');
    });

    it('404s a cross-tenant scan read', async () => {
      const bobScan = ctx.db
        .prepare('SELECT id FROM scan_results WHERE owner_id = ?')
        .get(bob.user.id);

      const res = await as(request(ctx.app).get(`/api/scans/${bobScan.id}`), alice.token);
      expect(res.status).toBe(404);
    });

    it('scopes per-website scan history', async () => {
      const res = await as(
        request(ctx.app).get(`/api/scans/website/${bobSite.id}`),
        alice.token
      );
      expect(res.body).toHaveLength(0);
    });

    it('refuses a cross-tenant remark', async () => {
      const bobScan = ctx.db
        .prepare('SELECT id FROM scan_results WHERE owner_id = ?')
        .get(bob.user.id);

      const res = await as(request(ctx.app).patch(`/api/scans/${bobScan.id}`), alice.token)
        .send({ remark: 'tampered' });

      expect(res.status).toBe(404);
    });

    // The export endpoint returns a compressed PDF, so searching its bytes for
    // a leaked name would pass whether or not the leak exists. Assert against
    // the rows the endpoint is built from instead, then smoke-test the HTTP
    // path separately.
    it('selects only the caller’s scans for export', () => {
      const scanRepo = require('../src/repositories/scanRepo');

      const forAlice = scanRepo.listForExport(alice.user.id, null);
      expect(forAlice).toHaveLength(1);
      expect(forAlice[0].llm_summary).toContain('Alice');
    });

    it('intersects a supplied id list with owned scans', () => {
      const scanRepo = require('../src/repositories/scanRepo');
      const bobScan = ctx.db
        .prepare('SELECT id FROM scan_results WHERE owner_id = ?')
        .get(bob.user.id);

      // A crafted id list must not pull in another tenant's report.
      const selected = scanRepo.listForExport(alice.user.id, [bobScan.id]);
      expect(selected).toHaveLength(0);
    });

    it('still serves a PDF over HTTP', async () => {
      const res = await as(request(ctx.app).get('/api/scans/export-pdf'), alice.token);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    });
  });

  describe('operator-only surfaces', () => {
    it('refuses the whole-database export to a subscriber', async () => {
      const res = await as(request(ctx.app).get('/api/database/export'), alice.token);
      expect(res.status).toBe(403);
    });

    it('refuses the destructive import to a subscriber', async () => {
      const res = await as(request(ctx.app).post('/api/database/import'), alice.token);
      expect(res.status).toBe(403);
    });

    it('refuses the admin API to a subscriber', async () => {
      const res = await as(request(ctx.app).get('/api/admin/users'), alice.token);
      expect(res.status).toBe(403);
    });

    it('gives the operator no implicit access to tenant data', async () => {
      const admin = await request(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'admin@local', password: 'test-admin-password' });

      const websites = await as(request(ctx.app).get('/api/websites'), admin.body.token);
      const scans = await as(request(ctx.app).get('/api/scans'), admin.body.token);

      // The operator can see platform metadata, not customers' monitored sites.
      expect(websites.body).toHaveLength(0);
      expect(scans.body.total).toBe(0);
    });
  });
});
