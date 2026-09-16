/**
 * The shared login.
 *
 * Credentials live in the environment, not the database, so there is exactly
 * one thing standing between an attacker and every monitored site. These tests
 * pin that: the right pair gets a token, anything else does not, and a token is
 * required everywhere past /api/auth.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

const { createTestApp, signIn, as } = require('./helpers');

let harness;

beforeAll(() => {
  harness = createTestApp();
});

afterAll(() => harness.cleanup());

describe('signing in', () => {
  it('issues a token for the configured username and password', async () => {
    const res = await request(harness.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'test-admin-password' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.username).toBe('admin');
  });

  it('never returns a password or a hash', async () => {
    const res = await request(harness.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'test-admin-password' });

    expect(JSON.stringify(res.body)).not.toContain('test-admin-password');
    expect(JSON.stringify(res.body)).not.toContain('$2a$');
  });

  it('rejects the wrong password', async () => {
    const res = await request(harness.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'not-the-password' });

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it('rejects an unknown username', async () => {
    const res = await request(harness.app)
      .post('/api/auth/login')
      .send({ username: 'someone-else', password: 'test-admin-password' });

    expect(res.status).toBe(401);
  });

  it('requires both fields', async () => {
    const res = await request(harness.app).post('/api/auth/login').send({ username: 'admin' });
    expect(res.status).toBe(400);
  });

  it('refuses to sign anyone in when AUTH_PASSWORD is unset', async () => {
    // An unset expected password must not mean "anything matches" — the server
    // says it is misconfigured rather than opening the door.
    const original = process.env.AUTH_PASSWORD;
    delete process.env.AUTH_PASSWORD;
    try {
      const res = await request(harness.app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'anything at all' });

      expect(res.status).toBe(500);
      expect(res.body.token).toBeUndefined();
    } finally {
      process.env.AUTH_PASSWORD = original;
    }
  });

  it('binds the token to the account that owns the data', async () => {
    const { token } = await signIn(request, harness.app);
    const payload = jwt.decode(token);

    const owner = harness.db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
    expect(payload.userId).toBe(owner.id);
  });
});

describe('sessions', () => {
  it('rejects a request with no token', async () => {
    const res = await request(harness.app).get('/api/websites');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await request(harness.app)
      .get('/api/websites')
      .set('Authorization', 'test-admin-password');

    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ userId: 1 }, 'not-the-servers-secret', { expiresIn: '1h' });
    const res = await as(request(harness.app).get('/api/websites'), forged);

    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const res = await as(request(harness.app).get('/api/websites'), expired);

    expect(res.status).toBe(401);
  });

  it('rejects a token naming an account that no longer exists', async () => {
    const orphan = jwt.sign({ userId: 999_999 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await as(request(harness.app).get('/api/websites'), orphan);

    expect(res.status).toBe(401);
  });

  it('rejects a token from the account-based scheme, which carried no userId', async () => {
    const legacy = jwt.sign({ username: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await as(request(harness.app).get('/api/websites'), legacy);

    expect(res.status).toBe(401);
  });

  it('accepts a valid token and reports who is signed in', async () => {
    const { token } = await signIn(request, harness.app);

    const me = await as(request(harness.app).get('/api/auth/me'), token);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');

    const websites = await as(request(harness.app).get('/api/websites'), token);
    expect(websites.status).toBe(200);
  });
});

describe('removed account endpoints', () => {
  // Signup behind a shared password would be a way straight past it.
  it.each([
    ['/api/auth/signup'],
    ['/api/auth/forgot-password'],
    ['/api/auth/reset-password'],
    ['/api/auth/verify-email'],
    ['/api/auth/change-password'],
  ])('%s is gone', async (path) => {
    const res = await request(harness.app).post(path).send({});
    expect(res.status).toBe(404);
  });

  it('no longer exposes billing or platform administration', async () => {
    const { token } = await signIn(request, harness.app);

    for (const path of ['/api/billing/plans', '/api/billing/subscription', '/api/admin/stats']) {
      const res = await as(request(harness.app).get(path), token);
      expect(res.status).toBe(404);
    }
  });
});
