/**
 * The subscription state machine.
 *
 * Stripe and PayPal describe subscriptions differently. Each provider adapter
 * normalises its webhook payloads into the shape below, and this module is the
 * ONLY code that writes the `subscriptions` table. Keeping one writer is what
 * lets two gateways share one entitlement model.
 *
 * Internal statuses:
 *
 *   incomplete → checkout started, not yet paid
 *   trialing   → in a free trial, entitled
 *   active     → paid and current, entitled
 *   past_due   → payment failed, entitled during the grace window
 *   unpaid     → dunning exhausted, not entitled
 *   canceled   → ended, not entitled
 *
 * A cancellation scheduled for the end of the period stays `active` with
 * `cancel_at_period_end = 1`, so the customer keeps what they paid for.
 */

const db = require('../../db');
const planRepo = require('../../repositories/planRepo');
const subscriptionRepo = require('../../repositories/subscriptionRepo');
const websiteRepo = require('../../repositories/websiteRepo');
const scheduleRepo = require('../../repositories/scheduleRepo');
const userRepo = require('../../repositories/userRepo');
const entitlements = require('../entitlements');
const mailer = require('../mailer');
const emails = require('../emails');

const STATUSES = [
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
];

/**
 * Record a webhook event, returning false if it has already been processed.
 *
 * Both gateways retry delivery, and Stripe explicitly recommends assuming
 * at-least-once. The UNIQUE(provider, event_id) constraint makes replay a
 * no-op rather than a double charge or a double plan change.
 */
function claimEvent(provider, eventId, type, payload) {
  if (!eventId) return true; // nothing to deduplicate against; process it

  try {
    db.prepare(
      `INSERT INTO webhook_events (provider, event_id, type, payload)
       VALUES (?, ?, ?, ?)`
    ).run(provider, eventId, type || null, payload ? JSON.stringify(payload) : null);
    return true;
  } catch {
    return false; // UNIQUE violation — already seen
  }
}

function markEventProcessed(provider, eventId, error) {
  if (!eventId) return;
  db.prepare(
    `UPDATE webhook_events
        SET processed_at = CURRENT_TIMESTAMP, error = ?
      WHERE provider = ? AND event_id = ?`
  ).run(error || null, provider, eventId);
}

/**
 * Apply a normalised subscription event.
 *
 * @param {object} event
 * @param {number} event.userId
 * @param {string} event.provider           'stripe' | 'paypal'
 * @param {string} event.status             an internal status
 * @param {string} [event.planSlug]
 * @param {string} [event.providerSubId]
 * @param {string} [event.providerCustomerId]
 * @param {string} [event.periodStart]      ISO
 * @param {string} [event.periodEnd]        ISO
 * @param {boolean} [event.cancelAtPeriodEnd]
 * @param {string} [event.trialEnd]         ISO
 * @returns {object} the resulting subscription row
 */
function applySubscriptionEvent(event) {
  if (!STATUSES.includes(event.status)) {
    throw new Error(`Unknown subscription status: ${event.status}`);
  }

  const existing =
    subscriptionRepo.findByProviderSubId(event.provider, event.providerSubId) ||
    subscriptionRepo.findLiveForUser(event.userId);

  const plan = event.planSlug ? planRepo.getBySlug(event.planSlug) : null;
  const planId = plan?.id || existing?.plan_id || planRepo.getDefaultPlan().id;

  const previousPlanId = existing?.plan_id ?? null;

  const fields = {
    user_id: event.userId,
    plan_id: planId,
    status: event.status,
    provider: event.provider,
    provider_sub_id: event.providerSubId ?? existing?.provider_sub_id ?? null,
    provider_customer_id:
      event.providerCustomerId ?? existing?.provider_customer_id ?? null,
    current_period_start: event.periodStart ?? existing?.current_period_start ?? null,
    current_period_end: event.periodEnd ?? existing?.current_period_end ?? null,
    cancel_at_period_end: event.cancelAtPeriodEnd ? 1 : 0,
    trial_end: event.trialEnd ?? existing?.trial_end ?? null,
    canceled_at:
      event.status === 'canceled'
        ? existing?.canceled_at || new Date().toISOString()
        : null,
    // Stamped the first time a subscription goes past_due, so the grace window
    // is measured from the original failure rather than the latest retry.
    past_due_since:
      event.status === 'past_due'
        ? existing?.past_due_since || new Date().toISOString()
        : null,
  };

  const subscription = existing
    ? subscriptionRepo.update(existing.id, fields)
    : subscriptionRepo.create(fields);

  const planChanged = previousPlanId !== null && previousPlanId !== planId;
  const lostEntitlement = ['canceled', 'unpaid'].includes(event.status);

  if (planChanged || lostEntitlement) {
    reconcileToPlan(event.userId);
  }

  return subscription;
}

/**
 * Bring a user's resources back within the allowances they are now entitled to.
 *
 * Nothing is deleted. Websites over the new cap are deactivated newest-first
 * (the oldest are the ones they have history for), and schedules the new plan
 * does not permit are switched off. Re-upgrading reactivates neither
 * automatically — the customer chooses which sites matter.
 */
function reconcileToPlan(userId) {
  const limits = entitlements.getEntitlements(userId);

  const parked = websiteRepo.deactivateOverLimit(userId, limits.max_websites);
  const stopped = scheduleRepo.disableDisallowed(userId, limits.schedules || []);

  if (parked > 0 || stopped > 0) {
    console.log(
      `Plan change for user ${userId}: parked ${parked} website(s), ` +
        `disabled ${stopped} schedule(s) to fit the new plan.`
    );
    notifyDowngrade(userId, parked, stopped).catch(() => {});
  }

  return { parked, stopped };
}

async function notifyDowngrade(userId, parked, stopped) {
  const user = userRepo.findById(userId);
  if (!user || !user.notify_billing) return;

  const message = emails.planDowngraded({ parked, stopped });
  await mailer.send({ to: user.email, ...message });
}

/**
 * Record a payment. Idempotent on (provider, provider_payment_id).
 * @returns {boolean} true when this call inserted the row
 */
function recordPayment({
  userId,
  subscriptionId = null,
  provider,
  providerPaymentId,
  amountCents,
  currency,
  status,
  invoiceUrl = null,
  paidAt = null,
  raw = null,
}) {
  try {
    db.prepare(
      `INSERT INTO payments (user_id, subscription_id, provider, provider_payment_id,
                             amount_cents, currency, status, invoice_url, paid_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      subscriptionId,
      provider,
      providerPaymentId,
      amountCents,
      currency,
      status,
      invoiceUrl,
      paidAt,
      raw ? JSON.stringify(raw) : null
    );
    return true;
  } catch {
    return false; // already recorded
  }
}

function listPayments(userId, limit = 25) {
  return db
    .prepare(
      `SELECT id, provider, amount_cents, currency, status, invoice_url, paid_at
         FROM payments
        WHERE user_id = ?
        ORDER BY COALESCE(paid_at, id) DESC
        LIMIT ?`
    )
    .all(userId, limit);
}

module.exports = {
  STATUSES,
  claimEvent,
  markEventProcessed,
  applySubscriptionEvent,
  reconcileToPlan,
  recordPayment,
  listPayments,
};
