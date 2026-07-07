const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Resolve the credentials supplied at login to an account + role.
 *
 * Two accounts are supported:
 *   • Administrator — AUTH_USERNAME (default "admin") / AUTH_PASSWORD.
 *     Can add websites, import from Excel/CSV, and export/import the database.
 *   • Regular user  — USER_USERNAME (default "user") / USER_PASSWORD.
 *     Optional; only exists when USER_PASSWORD is set. Can scan websites and
 *     view scan history, but cannot manage websites or the database.
 *
 * The administrator account always takes precedence when both accounts share
 * the same credentials.
 *
 * @returns {{ username: string, role: 'admin' | 'user' } | null}
 */
function resolveAccount(username, password) {
  const adminUser = process.env.AUTH_USERNAME || 'admin';
  const adminPass = process.env.AUTH_PASSWORD;
  if (adminPass && username === adminUser && password === adminPass) {
    return { username: adminUser, role: 'admin' };
  }

  const regularUser = process.env.USER_USERNAME || 'user';
  const regularPass = process.env.USER_PASSWORD;
  if (regularPass && username === regularUser && password === regularPass) {
    return { username: regularUser, role: 'user' };
  }

  return null;
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (!process.env.AUTH_PASSWORD) {
    return res.status(500).json({
      error: 'Server is not configured for authentication. Set AUTH_PASSWORD in the environment.',
    });
  }

  const account = resolveAccount(username, password);
  if (!account) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const secret = process.env.JWT_SECRET || 'change-me-in-production';
  const expiresIn = process.env.JWT_EXPIRES_IN || '24h';

  const token = jwt.sign(
    { username: account.username, role: account.role },
    secret,
    { expiresIn }
  );

  res.json({ token, username: account.username, role: account.role, expiresIn });
});

// GET /api/auth/me — verify a stored token and return the current user
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role || 'admin' });
});

// POST /api/auth/logout — client-side only (just a confirmation endpoint)
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out' });
});

module.exports = router;
