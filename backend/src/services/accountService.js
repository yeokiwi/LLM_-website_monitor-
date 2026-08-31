/**
 * Account primitives — password hashing, one-time tokens, JWT issuing, and the
 * boot-time superadmin seed.
 *
 * Passwords use bcryptjs (pure JS) rather than the native `bcrypt` binding: the
 * production image already compiles better-sqlite3, and a second native build
 * on Alpine is avoidable cost for no security difference.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const userRepo = require('../repositories/userRepo');

const BCRYPT_ROUNDS = 12;
const DEFAULT_JWT_SECRET = 'change-me-in-production';

const VERIFY_TOKEN_TTL_HOURS = 48;
const RESET_TOKEN_TTL_MINUTES = 60;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Minimum password policy. Deliberately length-first rather than a character
 * class checklist — length is what actually resists offline cracking.
 * @returns {string|null} an error message, or null when acceptable
 */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters';
  }
  if (password.length > 200) {
    return 'Password must be at most 200 characters';
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return EMAIL_RE.test(email) && email.length <= 320;
}

// ---------------------------------------------------------------------------
// One-time tokens
// ---------------------------------------------------------------------------

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** An ISO timestamp `hours` in the future, in the format SQLite comparisons expect. */
function expiryFromNow(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function verifyTokenExpiry() {
  return expiryFromNow(VERIFY_TOKEN_TTL_HOURS * 3600_000);
}

function resetTokenExpiry() {
  return expiryFromNow(RESET_TOKEN_TTL_MINUTES * 60_000);
}

function isExpired(isoTimestamp) {
  if (!isoTimestamp) return true;
  const t = Date.parse(isoTimestamp);
  return Number.isNaN(t) || t < Date.now();
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

function jwtSecret() {
  return process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
}

/** Issue a session token. The payload carries the user id, not just a name. */
function issueToken(user) {
  const expiresIn = process.env.JWT_EXPIRES_IN || '24h';
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    jwtSecret(),
    { expiresIn }
  );
  return { token, expiresIn };
}

// ---------------------------------------------------------------------------
// Boot-time seeding
// ---------------------------------------------------------------------------

/**
 * Seed the platform superadmin from AUTH_USERNAME / AUTH_PASSWORD.
 *
 * This is the break-glass account: it owns any data that predates real user
 * accounts (see the owner backfill migration) and can reach /api/admin/*. It is
 * created only when it does not already exist — an existing account's password
 * is never overwritten from the environment, so rotating AUTH_PASSWORD does not
 * silently change a live login.
 *
 * @returns {object|null} the superadmin user row, or null when unconfigured
 */
function seedSuperadmin() {
  const rawUsername = process.env.AUTH_USERNAME || 'admin';
  const password = process.env.AUTH_PASSWORD;

  if (!password) return null;

  // AUTH_USERNAME was historically a bare username ("admin"), but accounts are
  // now keyed by email. Anything without an "@" gets a local domain.
  const email = normalizeEmail(
    rawUsername.includes('@') ? rawUsername : `${rawUsername}@local`
  );

  const existing = userRepo.findByEmail(email);
  if (existing) return existing;

  return userRepo.create({
    email,
    passwordHash: hashPassword(password),
    name: 'Platform administrator',
    role: 'superadmin',
    emailVerifiedAt: new Date().toISOString(),
  });
}

/**
 * Warn loudly about insecure configuration, and refuse to run in production
 * with a default signing secret.
 */
function assertSecureConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const secret = process.env.JWT_SECRET;

  if (!secret || secret === DEFAULT_JWT_SECRET) {
    const message =
      'JWT_SECRET is unset or still the default value. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
    if (isProduction) {
      throw new Error(`Refusing to start in production — ${message}`);
    }
    console.warn(`⚠️  ${message}`);
  }

  if (process.env.USER_PASSWORD) {
    console.warn(
      '⚠️  USER_PASSWORD is set but no longer used. Accounts now live in the ' +
        'database — sign up through the app instead.'
    );
  }
}

module.exports = {
  BCRYPT_ROUNDS,
  DEFAULT_JWT_SECRET,
  hashPassword,
  verifyPassword,
  validatePassword,
  normalizeEmail,
  isValidEmail,
  randomToken,
  verifyTokenExpiry,
  resetTokenExpiry,
  isExpired,
  jwtSecret,
  issueToken,
  seedSuperadmin,
  assertSecureConfig,
};
