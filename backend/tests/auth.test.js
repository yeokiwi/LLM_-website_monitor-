/**
 * Accounts — signup, sign in, recovery and session handling.
 *
 * The previous scheme compared two env-var passwords in plaintext with `===`.
 * These tests pin the properties that replaced it.
 */

const request = require('supertest');
const { createTestApp, signup, as } = require('./helpers');

describe('accounts', () => {
  let ctx;

  beforeAll(() => { ctx = createTestApp(); });
  afterAll(() => ctx.cleanup());

  describe('signup', () => {
    it('creates an account and signs the user in', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: 'new@example.com', password: 'correct-horse-battery', name: 'New' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeTypeOf('string');
      expect(res.body.user.email).toBe('new@example.com');
      expect(res.body.plan.slug).toBe('free');
    });

    it('never returns the password hash or any token column', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: 'leak-check@example.com', password: 'correct-horse-battery' });

      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toContain('password_hash');
      expect(serialised).not.toContain('verify_token');
      expect(serialised).not.toContain('reset_token');
    });

    it('stores the password hashed, not in plaintext', () => {
      const row = ctx.db
        .prepare('SELECT password_hash FROM users WHERE email = ?')
        .get('new@example.com');

      expect(row.password_hash).not.toContain('correct-horse-battery');
      expect(row.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt
    });

    it('rejects a duplicate email regardless of case', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: 'NEW@Example.COM', password: 'another-password-here' });

      expect(res.status).toBe(409);
    });

    it('rejects a short password', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: 'short@example.com', password: 'short' });

      expect(res.status).toBe(400);
    });

    it('rejects a malformed email', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/signup')
        .send({ email: 'not-an-email', password: 'correct-horse-battery' });

      expect(res.status).toBe(400);
    });
  });

  describe('sign in', () => {
    it('accepts the right password', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'new@example.com', password: 'correct-horse-battery' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTypeOf('string');
    });

    it('rejects the wrong password', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'new@example.com', password: 'wrong-password-here' });

      expect(res.status).toBe(401);
    });

    it('gives the same answer for an unknown account, revealing nothing', async () => {
      const unknown = await request(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrong-password-here' });

      expect(unknown.status).toBe(401);
      expect(unknown.body.error).toBe('Invalid email or password');
    });

    it('seeds the platform operator from AUTH_USERNAME/AUTH_PASSWORD', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'admin@local', password: 'test-admin-password' });

      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('superadmin');
    });
  });

  describe('sessions', () => {
    it('rejects a request with no token', async () => {
      const res = await request(ctx.app).get('/api/websites');
      expect(res.status).toBe(401);
    });

    it('rejects a forged token', async () => {
      const res = await as(request(ctx.app).get('/api/websites'), 'not.a.real.token');
      expect(res.status).toBe(401);
    });

    it('rejects a token signed with a different secret', async () => {
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign({ userId: 1, role: 'superadmin' }, 'some-other-secret');

      const res = await as(request(ctx.app).get('/api/websites'), forged);
      expect(res.status).toBe(401);
    });

    it('rejects a validly signed token for a user that no longer exists', async () => {
      const jwt = require('jsonwebtoken');
      const orphan = jwt.sign(
        { userId: 999999, email: 'ghost@example.com', role: 'superadmin' },
        process.env.JWT_SECRET
      );

      const res = await as(request(ctx.app).get('/api/websites'), orphan);
      expect(res.status).toBe(401);
    });

    it('locks out a suspended account immediately, without waiting for expiry', async () => {
      const account = await signup(request, ctx.app, 'suspended@example.com');

      const before = await as(request(ctx.app).get('/api/websites'), account.token);
      expect(before.status).toBe(200);

      ctx.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(account.user.id);

      const after = await as(request(ctx.app).get('/api/websites'), account.token);
      expect(after.status).toBe(403);
    });

    it('does not honour a token from the previous env-var scheme', async () => {
      const jwt = require('jsonwebtoken');
      // The old payload had no userId at all.
      const legacy = jwt.sign({ username: 'admin', role: 'admin' }, process.env.JWT_SECRET);

      const res = await as(request(ctx.app).get('/api/websites'), legacy);
      expect(res.status).toBe(401);
    });
  });

  describe('password recovery', () => {
    it('answers identically whether or not the email is registered', async () => {
      const known = await request(ctx.app)
        .post('/api/auth/forgot-password')
        .send({ email: 'new@example.com' });

      const unknown = await request(ctx.app)
        .post('/api/auth/forgot-password')
        .send({ email: 'nobody-at-all@example.com' });

      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body).toEqual(unknown.body);
    });

    it('resets the password with a valid token', async () => {
      await request(ctx.app)
        .post('/api/auth/forgot-password')
        .send({ email: 'new@example.com' });

      const { reset_token } = ctx.db
        .prepare('SELECT reset_token FROM users WHERE email = ?')
        .get('new@example.com');

      const reset = await request(ctx.app)
        .post('/api/auth/reset-password')
        .send({ token: reset_token, password: 'a-brand-new-password' });

      expect(reset.status).toBe(200);

      const signedIn = await request(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'new@example.com', password: 'a-brand-new-password' });
      expect(signedIn.status).toBe(200);

      const oldPassword = await request(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'new@example.com', password: 'correct-horse-battery' });
      expect(oldPassword.status).toBe(401);
    });

    it('consumes the reset token so it cannot be replayed', async () => {
      await request(ctx.app)
        .post('/api/auth/forgot-password')
        .send({ email: 'leak-check@example.com' });

      const { reset_token } = ctx.db
        .prepare('SELECT reset_token FROM users WHERE email = ?')
        .get('leak-check@example.com');

      const first = await request(ctx.app)
        .post('/api/auth/reset-password')
        .send({ token: reset_token, password: 'first-new-password' });
      expect(first.status).toBe(200);

      const replay = await request(ctx.app)
        .post('/api/auth/reset-password')
        .send({ token: reset_token, password: 'second-new-password' });
      expect(replay.status).toBe(400);
    });

    it('rejects an expired reset token', async () => {
      const account = await signup(request, ctx.app, 'expired@example.com');
      await request(ctx.app)
        .post('/api/auth/forgot-password')
        .send({ email: 'expired@example.com' });

      ctx.db
        .prepare('UPDATE users SET reset_expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), account.user.id);

      const { reset_token } = ctx.db
        .prepare('SELECT reset_token FROM users WHERE id = ?')
        .get(account.user.id);

      const res = await request(ctx.app)
        .post('/api/auth/reset-password')
        .send({ token: reset_token, password: 'too-late-password' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/expired/i);
    });
  });

  describe('email verification', () => {
    it('confirms an address with its token', async () => {
      const account = await signup(request, ctx.app, 'verify@example.com');

      const { verify_token } = ctx.db
        .prepare('SELECT verify_token FROM users WHERE id = ?')
        .get(account.user.id);

      const res = await request(ctx.app)
        .post('/api/auth/verify-email')
        .send({ token: verify_token });

      expect(res.status).toBe(200);

      const after = ctx.db
        .prepare('SELECT email_verified_at, verify_token FROM users WHERE id = ?')
        .get(account.user.id);
      expect(after.email_verified_at).toBeTruthy();
      expect(after.verify_token).toBeNull();
    });

    it('rejects an unknown token', async () => {
      const res = await request(ctx.app)
        .post('/api/auth/verify-email')
        .send({ token: 'made-up-token' });

      expect(res.status).toBe(400);
    });
  });

  describe('password change', () => {
    it('requires the current password', async () => {
      const account = await signup(request, ctx.app, 'change@example.com');

      const wrong = await as(request(ctx.app).post('/api/auth/change-password'), account.token)
        .send({ currentPassword: 'not-the-password', newPassword: 'a-fresh-password' });
      expect(wrong.status).toBe(401);

      const right = await as(request(ctx.app).post('/api/auth/change-password'), account.token)
        .send({ currentPassword: 'correct-horse-battery', newPassword: 'a-fresh-password' });
      expect(right.status).toBe(200);
    });
  });
});
