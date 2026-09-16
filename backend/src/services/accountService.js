/**
 * Account primitives — password hashing, JWT issuing, and the boot-time seed of
 * the single account that owns the data.
 *
 * Sign-in credentials themselves live in the environment (see routes/auth.js).
 * Hashing survives here because the seeded row still needs a `password_hash`
 * and because the column is `NOT NULL`; nothing verifies against it.
 *
 * Passwords use bcryptjs (pure JS) rather than the native `bcrypt` binding: the
 * production image already compiles better-sqlite3, and a second native build
 * on Alpine is avoidable cost for no security difference.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const userRepo = require('../repositories/userRepo');

const BCRYPT_ROUNDS = 12;
const DEFAULT_JWT_SECRET = 'change-me-in-production';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function jwtSecret() {
  return process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
}

/**
 * Issue a session for the account that owns the data.
 *
 * The payload carries `userId` so `requireAuth` can load the row and every
 * owner-scoped query downstream keeps working without knowing that there is
 * only ever one account.
 */
function issueToken(user) {
  const expiresIn = process.env.JWT_EXPIRES_IN || '24h';
  const token = jwt.sign({ userId: user.id, email: user.email }, jwtSecret(), { expiresIn });
  return { token, expiresIn };
}

// ---------------------------------------------------------------------------
// Boot-time seeding
// ---------------------------------------------------------------------------

/**
 * Seed the account that owns everything, named after `AUTH_USERNAME`.
 *
 * Its stored password is not what anyone signs in with — `routes/auth.js`
 * compares against the environment — so the row exists purely to satisfy the
 * `owner_id` foreign keys on `websites`, `scan_results` and `schedules`.
 *
 * @returns {object|null} the user row, or null when AUTH_USERNAME is unusable
 */
function seedSuperadmin() {
  const rawUsername = process.env.AUTH_USERNAME || 'admin';

  // `AUTH_USERNAME` is a bare name ("admin"), but the column is an email with a
  // UNIQUE constraint, so anything without an "@" gets a local domain.
  const email = normalizeEmail(
    rawUsername.includes('@') ? rawUsername : `${rawUsername}@local`
  );
  if (!email) return null;

  const existing = userRepo.findByEmail(email);
  if (existing) return existing;

  return userRepo.create({
    email,
    passwordHash: hashPassword(process.env.AUTH_PASSWORD || randomFillerPassword()),
    name: 'Administrator',
  });
}

/** A value for the unused `password_hash` column when AUTH_PASSWORD is unset. */
function randomFillerPassword() {
  return require('crypto').randomBytes(24).toString('base64url');
}

/**
 * Warn loudly about insecure configuration, and refuse to run in production
 * with a default signing secret or no password at all.
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

  if (!process.env.AUTH_PASSWORD) {
    const message = 'AUTH_PASSWORD is not set — nobody can sign in until it is.';
    if (isProduction) {
      throw new Error(`Refusing to start in production — ${message}`);
    }
    console.warn(`⚠️  ${message}`);
  }
}

module.exports = {
  BCRYPT_ROUNDS,
  DEFAULT_JWT_SECRET,
  hashPassword,
  normalizeEmail,
  jwtSecret,
  issueToken,
  seedSuperadmin,
  assertSecureConfig,
};
