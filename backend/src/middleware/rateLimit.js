/**
 * Rate limiting.
 *
 * The auth endpoints previously had none, which made the login route
 * brute-forceable — and with a single shared password that is the only thing
 * standing between an attacker and the whole deployment.
 */

const rateLimit = require('express-rate-limit');

const DISABLED = /^(1|true|yes)$/i.test(process.env.DISABLE_RATE_LIMIT || '');

/** A limiter that becomes a pass-through when rate limiting is disabled. */
function limiter(options) {
  if (DISABLED) return (req, res, next) => next();

  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
  });
}

/** Login — keyed per IP. */
const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
  // Reading your own session is not an attack surface worth throttling.
  skip: (req) => req.method === 'GET',
});

/**
 * General API ceiling. Generous — it exists to stop a runaway client or a
 * scripted abuser, not to shape normal use.
 */
const apiLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 120,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
  // No custom keyGenerator: the default keys per client IP and normalises IPv6
  // into a /64 block, which a raw `req.ip` would let a client rotate around.
  //
  // Signed-in callers used to be keyed per account. That made sense with one
  // account per customer; with a single shared login it would put every client
  // in the building into one bucket, and a bulk scan would trip it.
});

module.exports = { authLimiter, apiLimiter, limiter };
