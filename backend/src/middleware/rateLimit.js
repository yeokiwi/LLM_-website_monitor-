/**
 * Rate limiting.
 *
 * The auth endpoints previously had none, which made the login route
 * brute-forceable. Signup and password reset also need a cap: both send email
 * and create rows on an unauthenticated request.
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

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

/** Login, signup, password reset — keyed per IP. */
const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
  // Reading your own session is not an attack surface worth throttling.
  skip: (req) => req.method === 'GET',
});

/**
 * General API ceiling. Generous — it exists to stop a runaway client or a
 * scripted abuser, not to shape normal use. Plan quotas do the commercial
 * limiting.
 */
const apiLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 120,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
  // Signed-in callers are keyed per account so one busy office network does not
  // throttle everyone behind it. `ipKeyGenerator` normalises IPv6 into a /64
  // block, which a raw `req.ip` would let a client trivially rotate around.
  keyGenerator: (req, res) =>
    req.user ? `u:${req.user.userId}` : ipKeyGenerator(req, res),
});

module.exports = { authLimiter, apiLimiter, limiter };
