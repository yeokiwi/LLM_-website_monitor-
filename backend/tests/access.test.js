/**
 * Access control.
 *
 * There is one shared login, so there are no tenants to keep apart — but every
 * read is still owner-scoped at the repository, and that scoping is what makes
 * the ownership columns worth keeping. These tests assert two things:
 *
 *   • nothing past /api/auth answers without a token;
 *   • a row belonging to another owner id stays invisible, including when its
 *     id is handed to an endpoint directly.
 *
 * The second is tested by writing a row under a second owner id straight into
 * the database. Nothing in the running app can create one, which is the point:
 * if the scoping is ever dropped, this is what notices.
 */

const request = require('supertest');
const { createTestApp, signIn, ownerId, as } = require('./helpers');

describe('access control', () => {
  let ctx;
  let session;
  let owner;
  let stranger;
  let site;
  let strangerSite;

  beforeAll(async () => {
    ctx = createTestApp();
    session = await signIn(request, ctx.app);
    owner = ownerId(ctx.db);

    site = (
      await as(request(ctx.app).post('/api/websites'), session.token)
        .send({ url: 'https://example.com/news', name: 'Monitored site' })
    ).body;

    stranger = ctx.db
      .prepare(
        `INSERT INTO users (email, password_hash, name)
         VALUES ('stranger@local', 'unused', 'Stranger') RETURNING id`
      )
      .get().id;

    strangerSite = ctx.db
      .prepare(
        `INSERT INTO websites (owner_id, url, name)
         VALUES (?, 'https://example.com/other', 'Not ours') RETURNING id`
      )
      .get(stranger).id;
  });

  afterAll(() => ctx.cleanup());

  describe('authentication', () => {
    it.each([
      ['get', '/api/websites'],
      ['get', '/api/scans'],
      ['get', '/api/schedules'],
      ['get', '/api/database/export'],
      ['post', '/api/database/import'],
      ['post', '/api/scans'],
      ['post', '/api/upload'],
    ])('refuses %s %s without a token', async (method, path) => {
      const res = await request(ctx.app)[method](path);
      expect(res.status).toBe(401);
    });

    it('serves /api/health without a token, so the platform healthcheck works', async () => {
      const res = await request(ctx.app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('owner scoping', () => {
    beforeAll(() => {
      // Insert scan rows directly: a real scan would hit the network and an LLM.
      const insert = (websiteId, ownerFor, summary) => {
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
          .run(websiteId, ownerFor, snapshot.lastInsertRowid, summary);
      };

      insert(site.id, owner, 'Our report');
      insert(strangerSite, stranger, 'Someone else’s report');
    });

    it('lists only websites belonging to the signed-in account', async () => {
      const res = await as(request(ctx.app).get('/api/websites'), session.token);

      expect(res.body.map((w) => w.id)).toContain(site.id);
      expect(res.body.map((w) => w.id)).not.toContain(strangerSite);
    });

    it('404s a website owned by someone else rather than 403', async () => {
      // 403 would confirm the row exists.
      const res = await as(request(ctx.app).get(`/api/websites/${strangerSite}`), session.token);
      expect(res.status).toBe(404);
    });

    it('lists only scans belonging to the signed-in account', async () => {
      const res = await as(request(ctx.app).get('/api/scans'), session.token);

      expect(res.body.total).toBe(1);
      expect(res.body.results[0].llm_summary).toBe('Our report');
    });

    it('404s a scan owned by someone else', async () => {
      const other = ctx.db
        .prepare('SELECT id FROM scan_results WHERE owner_id = ?')
        .get(stranger);

      const res = await as(request(ctx.app).get(`/api/scans/${other.id}`), session.token);
      expect(res.status).toBe(404);
    });

    it('intersects a supplied export id list with owned scans', () => {
      const scanRepo = require('../src/repositories/scanRepo');
      const other = ctx.db
        .prepare('SELECT id FROM scan_results WHERE owner_id = ?')
        .get(stranger);

      // A crafted id list must not pull in a row the caller does not own.
      expect(scanRepo.listForExport(owner, [other.id])).toHaveLength(0);
      expect(scanRepo.listForExport(owner, null)).toHaveLength(1);
    });

    it('still serves a PDF over HTTP', async () => {
      const res = await as(request(ctx.app).get('/api/scans/export-pdf'), session.token);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    });
  });

  describe('features that used to be paid', () => {
    // These were all behind a plan gate. With billing gone they must simply work.
    it('exports the whole database', async () => {
      const res = await as(request(ctx.app).get('/api/database/export'), session.token);
      expect(res.status).toBe(200);
    });

    it('exports websites as a spreadsheet', async () => {
      const res = await as(request(ctx.app).get('/api/websites/export'), session.token);
      expect(res.status).toBe(200);
    });

    it('exports the caller’s own data', async () => {
      const res = await as(request(ctx.app).get('/api/database/my-data'), session.token);
      expect(res.status).toBe(200);
    });

    it('offers every scheduling cadence', async () => {
      const res = await as(request(ctx.app).get('/api/schedules'), session.token);

      expect(res.status).toBe(200);
      expect(res.body.allowedFrequencies).toEqual(
        expect.arrayContaining(['hourly', 'daily', 'weekly'])
      );
    });

    it('accepts an hourly schedule', async () => {
      const res = await as(request(ctx.app).put(`/api/schedules/${site.id}`), session.token)
        .send({ frequency: 'hourly' });

      expect(res.status).toBe(200);
      expect(res.body.frequency).toBe('hourly');
    });
  });
});
