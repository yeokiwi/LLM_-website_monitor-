const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const expectedUsername = process.env.AUTH_USERNAME || 'admin';
  const expectedPassword = process.env.AUTH_PASSWORD;

  if (!expectedPassword) {
    return res.status(500).json({
      error: 'Server is not configured for authentication. Set AUTH_PASSWORD in the environment.',
    });
  }

  if (username !== expectedUsername || password !== expectedPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const secret = process.env.JWT_SECRET || 'change-me-in-production';
  const expiresIn = process.env.JWT_EXPIRES_IN || '24h';

  const token = jwt.sign({ username }, secret, { expiresIn });

  res.json({ token, username, expiresIn });
});

// GET /api/auth/me — verify a stored token and return the current user
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

// POST /api/auth/logout — client-side only (just a confirmation endpoint)
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out' });
});

module.exports = router;
