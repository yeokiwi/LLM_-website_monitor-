const jwt = require('jsonwebtoken');

const userRepo = require('../repositories/userRepo');
const { jwtSecret } = require('../services/accountService');

/**
 * Verifies the Bearer JWT and loads the account behind it.
 *
 * The user row is re-read on every request rather than trusted from the token
 * body, so a suspended or deleted account loses access immediately instead of
 * when its token happens to expire.
 *
 * On success `req.user` is `{ userId, email, role, record }`.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = payload.userId ? userRepo.findById(payload.userId) : null;

  if (!user) {
    // Includes tokens issued by the old env-var auth scheme, which carried no
    // userId — those holders simply sign in again.
    return res.status(401).json({ error: 'Account no longer exists' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: 'This account has been suspended' });
  }

  req.user = {
    userId: user.id,
    email: user.email,
    role: user.role,
    record: user,
  };

  next();
}

/**
 * Restricts a route to the platform superadmin — the operator of the service,
 * not a customer. Used for cross-tenant views and whole-database backup and
 * restore. Must run after `requireAuth`.
 *
 * Note this is NOT the old `requireAdmin`: managing websites is now something
 * every subscriber does within their own tenant, enforced by owner-scoped
 * queries rather than by a role check.
 */
function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Platform administrator privileges required' });
  }
  next();
}

/**
 * Rejects unverified accounts on routes that spend money or send mail.
 * Enabled only when REQUIRE_EMAIL_VERIFICATION is truthy, so a deployment
 * without SMTP configured is not locked out of its own product.
 */
function requireVerifiedEmail(req, res, next) {
  const enforced = /^(1|true|yes)$/i.test(process.env.REQUIRE_EMAIL_VERIFICATION || '');
  if (!enforced) return next();

  if (!req.user?.record?.email_verified_at) {
    return res.status(403).json({
      error: 'Please verify your email address to continue',
      code: 'EMAIL_UNVERIFIED',
    });
  }
  next();
}

module.exports = { requireAuth, requireSuperadmin, requireVerifiedEmail };
