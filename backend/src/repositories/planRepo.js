const db = require('../db');
const { PLANS, DEFAULT_PLAN_SLUG } = require('../config/plans');

/**
 * Upsert the code-defined plan catalog into the database.
 *
 * Called once on boot. Provider price/plan ids come from the environment so the
 * same catalog works against Stripe/PayPal test and live accounts without a
 * code change; an unset variable leaves the existing stored id untouched rather
 * than blanking it.
 */
function seedPlans() {
  const upsert = db.transaction(() => {
    for (const plan of PLANS) {
      const stripePriceId = plan.stripe_price_env
        ? process.env[plan.stripe_price_env] || null
        : null;
      const paypalPlanId = plan.paypal_plan_env
        ? process.env[plan.paypal_plan_env] || null
        : null;

      db.prepare(
        `INSERT INTO plans (slug, name, price_cents, currency, interval,
                            entitlements, stripe_price_id, paypal_plan_id,
                            is_active, sort_order)
         VALUES (@slug, @name, @price_cents, @currency, @interval,
                 @entitlements, @stripe_price_id, @paypal_plan_id, 1, @sort_order)
         ON CONFLICT(slug) DO UPDATE SET
           name            = excluded.name,
           price_cents     = excluded.price_cents,
           currency        = excluded.currency,
           interval        = excluded.interval,
           entitlements    = excluded.entitlements,
           stripe_price_id = COALESCE(excluded.stripe_price_id, plans.stripe_price_id),
           paypal_plan_id  = COALESCE(excluded.paypal_plan_id,  plans.paypal_plan_id),
           sort_order      = excluded.sort_order`
      ).run({
        slug: plan.slug,
        name: plan.name,
        price_cents: plan.price_cents,
        currency: plan.currency,
        interval: plan.interval,
        entitlements: JSON.stringify(plan.entitlements),
        stripe_price_id: stripePriceId,
        paypal_plan_id: paypalPlanId,
        sort_order: plan.sort_order,
      });
    }
  });

  upsert();
}

/** Parse the stored JSON entitlements blob into an object. */
function hydrate(row) {
  if (!row) return null;
  let entitlements = {};
  try {
    entitlements = JSON.parse(row.entitlements);
  } catch {
    entitlements = {};
  }
  return { ...row, entitlements };
}

function getBySlug(slug) {
  return hydrate(db.prepare('SELECT * FROM plans WHERE slug = ?').get(slug));
}

function getById(id) {
  return hydrate(db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
}

function getByStripePriceId(priceId) {
  if (!priceId) return null;
  return hydrate(db.prepare('SELECT * FROM plans WHERE stripe_price_id = ?').get(priceId));
}

function getByPaypalPlanId(planId) {
  if (!planId) return null;
  return hydrate(db.prepare('SELECT * FROM plans WHERE paypal_plan_id = ?').get(planId));
}

function listActive() {
  return db
    .prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order ASC')
    .all()
    .map(hydrate);
}

function getDefaultPlan() {
  return getBySlug(DEFAULT_PLAN_SLUG);
}

module.exports = {
  seedPlans,
  getBySlug,
  getById,
  getByStripePriceId,
  getByPaypalPlanId,
  listActive,
  getDefaultPlan,
};
