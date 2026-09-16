/**
 * Boot sequence.
 *
 * Ordering matters here: the ownership migration needs a user to assign
 * pre-existing data to, so it cannot run inside db/index.js alongside the
 * declarative schema. The steps are:
 *
 *   1. schema     — already done as a side effect of requiring ./db
 *   2. account    — seed the single account that owns everything
 *   3. ownership  — rebuild `websites` with an owner column, assigning legacy
 *                   rows to (2)
 */

const fs = require('fs');

const db = require('./db');
const { dbPath, migrations } = require('./db');
const accountService = require('./services/accountService');

/**
 * The single account that owns every website, scan and schedule.
 *
 * Sign-in does not consult it — credentials come from the environment — but the
 * `owner_id` foreign keys do, so it has to exist before anything can be stored.
 * It is named after AUTH_USERNAME; an account created under an earlier name is
 * reused rather than orphaning the data it owns.
 *
 * Idempotent, and safe to call on any request.
 */
function ensureSeedOwner() {
  const existing = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();
  if (existing) return existing;

  return accountService.seedSuperadmin();
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

  // Unconditional: an instance with no AUTH_PASSWORD still needs somewhere to
  // hang its data, and the account has to be there before the first request.
  ensureSeedOwner();

  if (!migrations.hasRun(db, migrations.OWNERSHIP_MIGRATION)) {
    const legacyWebsites = db.prepare('SELECT COUNT(*) AS n FROM websites').get().n;

    if (legacyWebsites > 0) {
      const backup = backupDatabaseFile('pre-owner-column');
      console.log(`📦 Backed up the database to ${backup} before adding the owner column.`);
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
