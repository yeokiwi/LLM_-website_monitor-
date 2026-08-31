/**
 * Account routes — signup, login, email verification and password recovery.
 *
 * Accounts live in the `users` table with bcrypt-hashed passwords. The previous
 * scheme (two accounts defined by AUTH_USERNAME/AUTH_PASSWORD and
 * USER_USERNAME/USER_PASSWORD, compared in plaintext) has been removed;
 * AUTH_USERNAME/AUTH_PASSWORD now seed a single platform superadmin on boot.
 */

const express = require('express');

const userRepo = require('../repositories/userRepo');
const { requireAuth } = require('../middleware/auth');
const { getAccountSummary } = require('../services/entitlements');
const mailer = require('../services/mailer');
const emails = require('../services/emails');
const {
  hashPassword,
  verifyPassword,
  validatePassword,
  normalizeEmail,
  isValidEmail,
  randomToken,
  verifyTokenExpiry,
  resetTokenExpiry,
  isExpired,
  issueToken,
} = require('../services/accountService');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/auth/signup — create an account and sign in
// Body: { email, password, name? }
// ---------------------------------------------------------------------------
router.post('/signup', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password, name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  if (userRepo.findByEmail(email)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const token = randomToken();
  const user = userRepo.create({
    email,
    passwordHash: hashPassword(password),
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    verifyToken: token,
    verifyExpiresAt: verifyTokenExpiry(),
  });

  const message = emails.verifyEmail({ name: user.name, token });
  await mailer.send({ to: user.email, ...message });

  const session = issueToken(user);
  userRepo.touchLogin(user.id);

  res.status(201).json({
    ...session,
    user: userRepo.toPublic(user),
    ...getAccountSummary(user.id),
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login — Body: { email, password }
// ---------------------------------------------------------------------------
router.post('/login', (req, res) => {
  // `username` is accepted as an alias so an older client posting the previous
  // field name still reaches the right place with a clear error.
  const email = normalizeEmail(req.body.email || req.body.username);
  const { password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = userRepo.findByEmail(email);

  // Verify against the found hash, or a dummy comparison when the account does
  // not exist, so response timing does not reveal which emails are registered.
  const ok = user
    ? verifyPassword(password, user.password_hash)
    : verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');

  if (!user || !ok) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: 'This account has been suspended' });
  }

  const session = issueToken(user);
  userRepo.touchLogin(user.id);

  res.json({
    ...session,
    user: userRepo.toPublic(user),
    ...getAccountSummary(user.id),
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email — Body: { token }
// ---------------------------------------------------------------------------
router.post('/verify-email', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Verification token is required' });
  }

  const user = userRepo.findByVerifyToken(token);
  if (!user) {
    return res.status(400).json({ error: 'This verification link is not valid' });
  }
  if (isExpired(user.verify_expires_at)) {
    return res.status(400).json({ error: 'This verification link has expired' });
  }

  userRepo.markVerified(user.id);
  res.json({ message: 'Email address confirmed' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/resend-verification — signed in, no body
// ---------------------------------------------------------------------------
router.post('/resend-verification', requireAuth, async (req, res) => {
  const user = req.user.record;

  if (user.email_verified_at) {
    return res.json({ message: 'Your email address is already confirmed' });
  }

  const token = randomToken();
  userRepo.setVerifyToken(user.id, token, verifyTokenExpiry());

  const message = emails.verifyEmail({ name: user.name, token });
  await mailer.send({ to: user.email, ...message });

  res.json({ message: 'Verification email sent' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password — Body: { email }
//
// Always answers 200 with the same message: whether an email is registered is
// not something an unauthenticated caller should be able to probe.
// ---------------------------------------------------------------------------
router.post('/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const generic = { message: 'If that email has an account, a reset link is on its way' };

  if (!email) return res.json(generic);

  const user = userRepo.findByEmail(email);
  if (!user || user.status !== 'active') return res.json(generic);

  const token = randomToken();
  userRepo.setResetToken(user.id, token, resetTokenExpiry());

  const message = emails.passwordReset({ token });
  await mailer.send({ to: user.email, ...message });

  res.json(generic);
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password — Body: { token, password }
// ---------------------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const user = userRepo.findByResetToken(token);
  if (!user) {
    return res.status(400).json({ error: 'This reset link is not valid' });
  }
  if (isExpired(user.reset_expires_at)) {
    return res.status(400).json({ error: 'This reset link has expired' });
  }

  userRepo.updatePassword(user.id, hashPassword(password));

  const message = emails.passwordChanged();
  await mailer.send({ to: user.email, ...message });

  res.json({ message: 'Password updated — you can now sign in' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/change-password — signed in
// Body: { currentPassword, newPassword }
// ---------------------------------------------------------------------------
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  if (!verifyPassword(currentPassword, req.user.record.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  userRepo.updatePassword(req.user.userId, hashPassword(newPassword));

  const message = emails.passwordChanged();
  await mailer.send({ to: req.user.email, ...message });

  res.json({ message: 'Password updated' });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — current account, plan, entitlements and usage
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: userRepo.toPublic(req.user.record),
    ...getAccountSummary(req.user.userId),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/auth/me — update profile / notification preferences
// Body: { notifyChanges?: boolean, notifyBilling?: boolean }
// ---------------------------------------------------------------------------
router.patch('/me', requireAuth, (req, res) => {
  const { notifyChanges, notifyBilling } = req.body;
  const updated = userRepo.updateNotificationPrefs(req.user.userId, {
    notifyChanges,
    notifyBilling,
  });
  res.json({ user: userRepo.toPublic(updated) });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout — client-side only (just a confirmation endpoint)
// ---------------------------------------------------------------------------
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out' });
});

module.exports = router;
