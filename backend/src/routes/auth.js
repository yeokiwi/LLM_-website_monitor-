/**
 * Authentication — one shared login for the whole deployment.
 *
 * Credentials live in the environment (`AUTH_USERNAME` / `AUTH_PASSWORD`), not
 * in the database: this is a single-team tool, not a service with customers.
 * There is no signup, no email verification and no password recovery, because
 * there are no accounts to recover — rotating `AUTH_PASSWORD` and restarting is
 * the whole story.
 *
 * A row in `users` still exists and still owns every website and scan through
 * `owner_id`. The token issued here carries that row's id, so `requireAuth` and
 * every owner-scoped query keep working unchanged.
 */

const crypto = require('crypto');
const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { ensureSeedOwner } = require('../bootstrap');
const { issueToken } = require('../services/accountService');

const router = express.Router();

/** The configured sign-in name. */
function expectedUsername() {
  return process.env.AUTH_USERNAME || 'admin';
}

/**
 * Constant-time string comparison.
 *
 * A plain `!==` returns as soon as two strings differ, so response timing leaks
 * the length and the matching prefix of the password. Hashing both sides first
 * gives `timingSafeEqual` the equal-length buffers it requires, whatever the
 * inputs.
 */
function matches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;

  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();

  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// POST /api/auth/login — Body: { username, password }
// ---------------------------------------------------------------------------
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const expectedPassword = process.env.AUTH_PASSWORD;

  if (!expectedPassword) {
    return res.status(500).json({
      error: 'Server is not configured for authentication. Set AUTH_PASSWORD in the environment.',
    });
  }

  // Both comparisons always run, so a wrong username and a wrong password take
  // the same time.
  const nameOk = matches(username, expectedUsername());
  const passwordOk = matches(password, expectedPassword);

  if (!nameOk || !passwordOk) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // The account row is what owns the data. It is seeded at boot, but seed it
  // here too so a database restored without one can still be signed into.
  const owner = ensureSeedOwner();
  const session = issueToken(owner);

  res.json({ ...session, username: expectedUsername() });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — verify a stored token and return the current user
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: expectedUsername() });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout — client-side only (just a confirmation endpoint)
// ---------------------------------------------------------------------------
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out' });
});

module.exports = router;
