/**
 * Boot sequence.
 *
 * Ordering matters here: the ownership migration needs a user to assign
 * pre-existing data to, so it cannot run inside db/index.js alongside the
 * declarative schema. The steps are:
 *
 *   1. schema      — already done as a side effect of requiring ./db
 *   2. plans       — upsert the code-defined catalog
 *   3. superadmin  — seed the operator account from AUTH_USERNAME/AUTH_PASSWORD
 *   4. ownership   — rebuild `websites` per-tenant, assigning legacy rows to (3)
 */

const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const { dbPath, migrations } = require('./db');
const planRepo = require('./repositories/planRepo');
const userRepo = require('./repositories/userRepo');
const accountService = require('./services/accountService');

/**
 * The account that inherits data created before user accounts existed.
 *
 * Normally this is the superadmin seeded from AUTH_USERNAME/AUTH_PASSWORD. If
 * that is not configured but there is legacy data to rescue, an account is
 * created with a generated password, printed once so the operator can sign in.
 */
function ensureSeedOwner() {
  const superadmin = accountService.seedSuperadmin();
  if (superadmin) return superadmin;

  const existing = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();
  if (existing) return existing;

  const password = crypto.randomBytes(12).toString('base64url');
  const user = userRepo.create({
    email: 'owner@localhost',
    passwordHash: accountService.hashPassword(password),
    name: 'Platform administrator',
    role: 'superadmin',
    emailVerifiedAt: new Date().toISOString(),
  });

  console.warn(
    '\n⚠️  No AUTH_PASSWORD was set, but this database already contains data.\n' +
      '   A platform administrator account has been created to own it:\n\n' +
      '      email:    owner@localhost\n' +
      `      password: ${password}\n\n` +
      '   Sign in and change this password now — it will not be shown again.\n'
  );

  return user;
}

/** Copy the database file aside before the one destructive migration. */
function backupDatabaseFile(label) {
  if (dbPath === ':memory:') return null;

  const backupPath = `${dbPath}.bak-${label}-${Date.now()}`;
  fs.writeFileSync(backupPath, db.serialize());
  return backupPath;
}

function bootstrap() {
  accountService.assertSecureConfig();

  planRepo.seedPlans();

  // Idempotent, and a no-op when AUTH_PASSWORD is unset.
  accountService.seedSuperadmin();

  if (!migrations.hasRun(db, migrations.OWNERSHIP_MIGRATION)) {
    const legacyWebsites = db.prepare('SELECT COUNT(*) AS n FROM websites').get().n;

    if (legacyWebsites > 0) {
      const backup = backupDatabaseFile('pre-multitenant');
      console.log(`📦 Backed up the database to ${backup} before migrating to multi-tenant.`);
    }

    const owner = ensureSeedOwner();
    migrations.backfillOwnership(db, owner.id);

    if (legacyWebsites > 0) {
      console.log(`✅ Migrated ${legacyWebsites} website(s) to ${owner.email}.`);
    }
  }

  // Also re-run on every boot: a crash between the two steps would otherwise
  // leave scan rows unowned, and unowned rows are invisible to their owner.
  migrations.backfillScanOwners(db);
}

module.exports = { bootstrap, ensureSeedOwner, backupDatabaseFile };
