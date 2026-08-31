const db = require('../db');
const planRepo = require('./planRepo');

/** Statuses that still grant the paid plan's entitlements. */
const LIVE_STATUSES = ['trialing', 'active', 'past_due'];

function hydrate(row) {
  if (!row) return null;
  return { ...row, plan: planRepo.getById(row.plan_id) };
}

/** The user's current entitling subscription, if any. */
function findLiveForUser(userId) {
  const placeholders = LIVE_STATUSES.map(() => '?').join(',');
  return hydrate(
    db
      .prepare(
        `SELECT * FROM subscriptions
          WHERE user_id = ? AND status IN (${placeholders})
          ORDER BY id DESC LIMIT 1`
      )
      .get(userId, ...LIVE_STATUSES)
  );
}

/**
 * The most recent subscription of any status — used to show a canceled plan's
 * history on the billing page, and to find the provider customer id for a
 * returning subscriber.
 */
function findLatestForUser(userId) {
  return hydrate(
    db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId)
  );
}

function findByProviderSubId(provider, providerSubId) {
  if (!providerSubId) return null;
  return hydrate(
    db
      .prepare('SELECT * FROM subscriptions WHERE provider = ? AND provider_sub_id = ?')
      .get(provider, providerSubId)
  );
}

function findById(id) {
  return hydrate(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id));
}

/** Any provider customer id we have previously stored for this user. */
function findProviderCustomerId(userId, provider) {
  const row = db
    .prepare(
      `SELECT provider_customer_id FROM subscriptions
        WHERE user_id = ? AND provider = ? AND provider_customer_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`
    )
    .get(userId, provider);
  return row?.provider_customer_id || null;
}

/** Which account a provider's customer id belongs to. */
function findUserIdByCustomerId(provider, customerId) {
  if (!customerId) return null;
  const row = db
    .prepare(
      `SELECT user_id FROM subscriptions
        WHERE provider = ? AND provider_customer_id = ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(provider, customerId);
  return row?.user_id || null;
}

const UPDATABLE = [
  'plan_id',
  'status',
  'provider',
  'provider_customer_id',
  'provider_sub_id',
  'current_period_start',
  'current_period_end',
  'cancel_at_period_end',
  'canceled_at',
  'past_due_since',
  'trial_end',
];

function create(fields) {
  const columns = UPDATABLE.filter((c) => fields[c] !== undefined);
  const sql = `INSERT INTO subscriptions (user_id, ${columns.join(', ')})
               VALUES (@user_id, ${columns.map((c) => `@${c}`).join(', ')})`;
  const result = db.prepare(sql).run({ user_id: fields.user_id, ...fields });
  return findById(result.lastInsertRowid);
}

function update(id, fields) {
  const columns = UPDATABLE.filter((c) => fields[c] !== undefined);
  if (columns.length === 0) return findById(id);

  const sets = columns.map((c) => `${c} = @${c}`).join(', ');
  db.prepare(
    `UPDATE subscriptions SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`
  ).run({ id, ...fields });

  return findById(id);
}

/** Superadmin oversight — every subscription with its owner's email. */
function listAll(limit = 100, offset = 0) {
  return db
    .prepare(
      `SELECT s.*, u.email, p.slug AS plan_slug, p.name AS plan_name
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         JOIN plans p ON p.id = s.plan_id
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

module.exports = {
  LIVE_STATUSES,
  findLiveForUser,
  findLatestForUser,
  findByProviderSubId,
  findById,
  findProviderCustomerId,
  findUserIdByCustomerId,
  create,
  update,
  listAll,
};
