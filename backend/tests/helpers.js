/**
 * Test harness.
 *
 * Every suite gets its own throwaway database file. `:memory:` is tempting but
 * the ownership migration reads and rebuilds tables across separate
 * connections, and a shared file is closer to how the app actually runs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Point the process at a fresh database and load the app.
 *
 * Node caches modules, and db/index.js resolves DB_PATH at require time, so the
 * environment must be set and the cache cleared before the app is loaded.
 *
 * @param {object} [env] extra environment for this suite
 * @returns {{ app, db, dbPath, cleanup }}
 */
function createTestApp(env = {}) {
  const dbPath = path.join(
    os.tmpdir(),
    `wm-test-${crypto.randomBytes(8).toString('hex')}.db`
  );

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    JWT_SECRET: 'test-secret-do-not-use-anywhere-real',
    AUTH_USERNAME: 'admin',
    AUTH_PASSWORD: 'test-admin-password',
    DISABLE_RATE_LIMIT: '1',
    ENABLE_SCHEDULER: 'false',
    // Leave SMTP unset so the mailer logs instead of sending.
    ...env,
  });

  resetModules();

  const app = require('../src/server');
  const db = require('../src/db');

  return {
    app,
    db,
    dbPath,
    cleanup() {
      try { db.close(); } catch { /* already closed */ }
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      }
      // Backups the ownership migration may have written alongside it.
      const dir = path.dirname(dbPath);
      const base = path.basename(dbPath);
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith(`${base}.bak-`)) {
          fs.rmSync(path.join(dir, file), { force: true });
        }
      }
      resetModules();
    },
  };
}

/** Drop every application module so the next load re-reads the environment. */
function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`) && !key.includes('node_modules')) {
      delete require.cache[key];
    }
  }
}

/** Sign up and return `{ token, user, ... }`. */
async function signup(request, app, email, password = 'correct-horse-battery') {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email, password });

  if (res.status !== 201) {
    throw new Error(`signup failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function login(request, app, email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** Attach a bearer token to a supertest request. */
const as = (req, token) => req.set('Authorization', `Bearer ${token}`);

/**
 * Move an account onto a plan without going through a payment gateway.
 * Mirrors what a webhook would do, so quota tests can exercise paid tiers.
 */
function grantPlan(db, userId, planSlug, status = 'active') {
  const plan = db.prepare('SELECT id FROM plans WHERE slug = ?').get(planSlug);
  const now = new Date();
  const end = new Date(now.getTime() + 30 * 86_400_000);

  db.prepare(
    `INSERT INTO subscriptions (user_id, plan_id, status, provider, provider_sub_id,
                                current_period_start, current_period_end)
     VALUES (?, ?, ?, 'stripe', ?, ?, ?)`
  ).run(
    userId,
    plan.id,
    status,
    `sub_test_${userId}_${planSlug}`,
    now.toISOString(),
    end.toISOString()
  );
}

module.exports = { createTestApp, signup, login, as, grantPlan, resetModules };
