/**
 * Schema definition and migrations.
 *
 * Two styles are used, matching what the codebase already did inline:
 *
 *   • Declarative — `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
 *     and try/catch `ALTER TABLE ADD COLUMN`. These are safe to re-run on every
 *     boot and are how all additive changes are made.
 *
 *   • Versioned — `runOnce(db, name, fn)` for migrations that must execute
 *     exactly once (table rebuilds, data backfills). Completion is recorded in
 *     `schema_migrations`, so a restart never repeats them.
 */

/** Name of the one-time migration that makes `websites` multi-tenant. */
const OWNERSHIP_MIGRATION = '2024_owner_scoped_websites';

/**
 * The multi-tenant shape of `websites`.
 *
 * The important difference from the original table is the unique constraint:
 * `url` was globally UNIQUE, which meant two customers could never monitor the
 * same site. It is now unique per owner.
 */
const TENANT_WEBSITES_DDL = `
  CREATE TABLE websites (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url           TEXT    NOT NULL,
    name          TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active     INTEGER DEFAULT 1,
    domain        TEXT,
    srms_owner    TEXT,
    srms          TEXT,
    remark        TEXT,
    use_firecrawl INTEGER DEFAULT 1,
    use_brave     INTEGER DEFAULT 1,
    use_serper    INTEGER DEFAULT 1,
    UNIQUE(owner_id, url)
  );
  CREATE INDEX IF NOT EXISTS idx_websites_owner ON websites(owner_id, is_active);
`;

function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

/** Add a column, ignoring the error SQLite throws when it already exists. */
function addColumn(db, table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    /* already exists */
  }
}

/** Run `fn` exactly once across the lifetime of this database. */
function runOnce(db, name, fn) {
  const done = db
    .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
    .get(name);
  if (done) return false;

  fn(db);

  db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
  return true;
}

/** True when the named migration has already been recorded as complete. */
function hasRun(db, name) {
  return !!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
}

function run(db) {
  // -------------------------------------------------------------------------
  // Migration bookkeeping — must exist before anything calls runOnce().
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // -------------------------------------------------------------------------
  // Core monitoring tables
  //
  // A fresh database gets the multi-tenant shape directly. An existing
  // single-tenant database keeps its original `websites` table until
  // `backfillOwnership()` rebuilds it, which needs a user to assign rows to and
  // therefore cannot run this early.
  // -------------------------------------------------------------------------
  if (!tableExists(db, 'websites')) {
    db.exec(TENANT_WEBSITES_DDL);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(OWNERSHIP_MIGRATION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS websites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      url        TEXT    NOT NULL UNIQUE,
      name       TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active  INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id   INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
      content_text TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      scraped_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_website_scraped
      ON snapshots(website_id, scraped_at);

    CREATE TABLE IF NOT EXISTS scan_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id      INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
      period_days     INTEGER NOT NULL,
      old_snapshot_id INTEGER REFERENCES snapshots(id),
      new_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
      diff_summary    TEXT,
      llm_summary     TEXT,
      status          TEXT DEFAULT 'pending',
      error_message   TEXT,
      scanned_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_scan_results_website
      ON scan_results(website_id, scanned_at);
  `);

  // SRMS metadata and per-website engine flags (pre-existing additive columns).
  for (const col of ['domain', 'srms_owner', 'srms', 'remark']) {
    addColumn(db, 'websites', col, 'TEXT');
  }
  for (const col of ['use_firecrawl', 'use_brave', 'use_serper']) {
    addColumn(db, 'websites', col, 'INTEGER DEFAULT 1');
  }
  addColumn(db, 'scan_results', 'remark', 'TEXT');

  // Ownership (denormalised from websites) plus the per-scan cost record that
  // usage metering and margin analysis need. `engines_used` was previously
  // computed and returned to the client but never stored.
  addColumn(db, 'scan_results', 'owner_id', 'INTEGER REFERENCES users(id)');
  addColumn(db, 'scan_results', 'triggered_by', "TEXT DEFAULT 'manual'");
  addColumn(db, 'scan_results', 'engines_used', 'TEXT');
  addColumn(db, 'scan_results', 'llm_input_tokens', 'INTEGER');
  addColumn(db, 'scan_results', 'llm_output_tokens', 'INTEGER');
  addColumn(db, 'scan_results', 'duration_ms', 'INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scan_results_owner
      ON scan_results(owner_id, scanned_at);
  `);

  // Provider-scoped snapshots so each engine diffs against its own history.
  addColumn(db, 'snapshots', 'provider', "TEXT DEFAULT 'default'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_snapshots_website_provider_scraped
      ON snapshots(website_id, provider, scraped_at);
  `);

  // -------------------------------------------------------------------------
  // Accounts and plan catalog
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash     TEXT NOT NULL,
      name              TEXT,
      role              TEXT NOT NULL DEFAULT 'user',    -- 'user' | 'superadmin'
      email_verified_at DATETIME,
      verify_token      TEXT,
      verify_expires_at DATETIME,
      reset_token       TEXT,
      reset_expires_at  DATETIME,
      status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended'
      notify_changes    INTEGER NOT NULL DEFAULT 1,
      notify_billing    INTEGER NOT NULL DEFAULT 1,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at     DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token);
    CREATE INDEX IF NOT EXISTS idx_users_reset_token  ON users(reset_token);

    CREATE TABLE IF NOT EXISTS plans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      slug            TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      price_cents     INTEGER NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL DEFAULT 'usd',
      interval        TEXT NOT NULL DEFAULT 'month',
      entitlements    TEXT NOT NULL,                     -- JSON
      stripe_price_id TEXT,
      paypal_plan_id  TEXT,
      is_active       INTEGER NOT NULL DEFAULT 1,
      sort_order      INTEGER NOT NULL DEFAULT 0
    );
  `);

  // -------------------------------------------------------------------------
  // Billing — subscriptions, usage metering, payments, webhook idempotency
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id              INTEGER NOT NULL REFERENCES plans(id),
      status               TEXT NOT NULL,
      provider             TEXT,
      provider_customer_id TEXT,
      provider_sub_id      TEXT,
      current_period_start DATETIME,
      current_period_end   DATETIME,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      canceled_at          DATETIME,
      past_due_since       DATETIME,
      trial_end            DATETIME,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- At most one entitling subscription per user at a time.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_live
      ON subscriptions(user_id)
      WHERE status IN ('trialing', 'active', 'past_due');

    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_sub
      ON subscriptions(provider, provider_sub_id)
      WHERE provider_sub_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS usage_counters (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period_start  TEXT NOT NULL,
      period_end    TEXT NOT NULL,
      scans_used    INTEGER NOT NULL DEFAULT 0,
      llm_calls     INTEGER NOT NULL DEFAULT 0,
      scrape_calls  INTEGER NOT NULL DEFAULT 0,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      warned_at     DATETIME,
      UNIQUE(user_id, period_start)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id     INTEGER REFERENCES subscriptions(id),
      provider            TEXT NOT NULL,
      provider_payment_id TEXT NOT NULL,
      amount_cents        INTEGER NOT NULL,
      currency            TEXT NOT NULL,
      status              TEXT NOT NULL,
      invoice_url         TEXT,
      paid_at             DATETIME,
      raw                 TEXT,
      UNIQUE(provider, provider_payment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, paid_at);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      provider     TEXT NOT NULL,
      event_id     TEXT NOT NULL,
      type         TEXT,
      received_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      error        TEXT,
      payload      TEXT,
      UNIQUE(provider, event_id)
    );
  `);

  // -------------------------------------------------------------------------
  // Scheduled scans
  //
  // No foreign key on website_id: the table is created before the ownership
  // rebuild may have recreated `websites`, and rows are cleaned up explicitly
  // when a website is removed.
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id  INTEGER NOT NULL UNIQUE,
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      frequency   TEXT NOT NULL,
      period_days INTEGER NOT NULL DEFAULT 30,
      is_enabled  INTEGER NOT NULL DEFAULT 1,
      next_run_at DATETIME NOT NULL,
      last_run_at DATETIME,
      last_status TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_due
      ON schedules(is_enabled, next_run_at);
  `);
}

/**
 * Rebuild `websites` into its multi-tenant shape and assign every existing row
 * to `ownerId`.
 *
 * This is the one destructive migration in the schema: SQLite cannot drop the
 * global `UNIQUE(url)` constraint, so the table has to be recreated and copied.
 * It runs at most once (guarded by `schema_migrations`), inside a transaction,
 * and preserves row ids so `snapshots.website_id` and `scan_results.website_id`
 * stay valid.
 *
 * Callers must take a file backup first — see bootstrap.js.
 *
 * @param {number} ownerId user who inherits all pre-existing data
 * @returns {boolean} whether the rebuild actually ran
 */
function backfillOwnership(db, ownerId) {
  if (hasRun(db, OWNERSHIP_MIGRATION)) return false;

  if (!ownerId) {
    throw new Error(
      'Cannot migrate existing websites to the multi-tenant schema without an owner account.'
    );
  }

  const rebuild = db.transaction(() => {
    db.exec(`
      ALTER TABLE websites RENAME TO websites_legacy;
      ${TENANT_WEBSITES_DDL}
    `);

    // Copy only the columns the legacy table actually has — older databases
    // predate some of the additive columns.
    const legacyColumns = db
      .prepare('PRAGMA table_info(websites_legacy)')
      .all()
      .map((c) => c.name);

    const carried = [
      'id', 'url', 'name', 'created_at', 'is_active', 'domain', 'srms_owner',
      'srms', 'remark', 'use_firecrawl', 'use_brave', 'use_serper',
    ].filter((c) => legacyColumns.includes(c));

    db.prepare(
      `INSERT INTO websites (owner_id, ${carried.join(', ')})
       SELECT ?, ${carried.join(', ')} FROM websites_legacy`
    ).run(ownerId);

    db.exec('DROP TABLE websites_legacy');
  });

  // Foreign keys are deferred for the rename/drop dance; better-sqlite3 forbids
  // toggling the pragma inside a transaction, so it is done around it.
  db.pragma('foreign_keys = OFF');
  try {
    rebuild();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(OWNERSHIP_MIGRATION);
  return true;
}

/**
 * Backfill `scan_results.owner_id` from the owning website.
 *
 * Denormalised deliberately: history and PDF export filter by owner on every
 * request, and this avoids a join on the hottest read path. Safe to re-run —
 * it only touches rows that are still NULL.
 */
function backfillScanOwners(db) {
  return db
    .prepare(
      `UPDATE scan_results
          SET owner_id = (SELECT w.owner_id FROM websites w WHERE w.id = scan_results.website_id)
        WHERE owner_id IS NULL`
    )
    .run().changes;
}

module.exports = {
  run,
  addColumn,
  runOnce,
  hasRun,
  tableExists,
  backfillOwnership,
  backfillScanOwners,
  OWNERSHIP_MIGRATION,
};
