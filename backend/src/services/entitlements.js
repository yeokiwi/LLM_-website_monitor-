/**
 * Entitlements — the single source of truth for what a given account may do.
 *
 * Everything that gates a feature or a limit resolves through here, so there is
 * exactly one place where "which plan is this user on, really?" is answered.
 *
 * Subscription status maps to entitlements as follows:
 *
 *   trialing / active   → the plan's entitlements
 *   past_due            → the plan's entitlements for BILLING_GRACE_DAYS from
 *                         the day the payment first failed, then Free. Dunning
 *                         takes time; cutting a paying customer off the instant
 *                         a card expires is the wrong default.
 *   canceled / unpaid   → Free (a cancellation scheduled for period end stays
 *                         `active` until the provider actually ends it, so the
 *                         customer keeps what they paid for)
 *   no subscription     → Free
 */

const planRepo = require('../repositories/planRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const usageRepo = require('../repositories/usageRepo');
const websiteRepo = require('../repositories/websiteRepo');

const DEFAULT_GRACE_DAYS = 7;

function graceDays() {
  const configured = parseInt(process.env.BILLING_GRACE_DAYS, 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_GRACE_DAYS;
}

/** Has a past_due subscription used up its grace window? */
function graceExpired(subscription) {
  const since = subscription.past_due_since || subscription.updated_at;
  if (!since) return false;
  const deadline = Date.parse(since) + graceDays() * 86_400_000;
  return Number.isFinite(deadline) && Date.now() > deadline;
}

/**
 * Resolve the plan a user is actually entitled to right now.
 * @returns {{ plan: object, subscription: object|null, inGrace: boolean }}
 */
function resolvePlan(userId) {
  const subscription = subscriptionRepo.findLiveForUser(userId);
  const freePlan = planRepo.getDefaultPlan();

  if (!subscription || !subscription.plan) {
    return { plan: freePlan, subscription: null, inGrace: false };
  }

  if (subscription.status === 'past_due') {
    if (graceExpired(subscription)) {
      return { plan: freePlan, subscription, inGrace: false };
    }
    return { plan: subscription.plan, subscription, inGrace: true };
  }

  return { plan: subscription.plan, subscription, inGrace: false };
}

/** The entitlements object for a user. */
function getEntitlements(userId) {
  return resolvePlan(userId).plan.entitlements;
}

/** Is a boolean feature unlocked for this user? */
function hasFeature(userId, feature) {
  return getEntitlements(userId)[feature] === true;
}

/**
 * The scraper engines this user's plan permits, intersected with the engines
 * the deployment actually has API keys for.
 */
function allowedEngines(userId) {
  const allowed = getEntitlements(userId).engines || ['direct'];
  return allowed.filter((engine) => {
    if (engine === 'firecrawl') return Boolean(process.env.FIRECRAWL_API_KEY);
    if (engine === 'brave') return Boolean(process.env.BRAVE_API_KEY);
    if (engine === 'serper') return Boolean(process.env.SERPER_API_KEY);
    return true; // 'direct' needs no key
  });
}

/** The scheduling frequencies this user's plan permits. */
function allowedSchedules(userId) {
  return getEntitlements(userId).schedules || [];
}

/**
 * Current usage against the current allowances.
 * @returns {{ window, scans: {used, limit, remaining}, websites: {used, limit, remaining} }}
 */
function getUsage(userId) {
  const { subscription, plan } = resolvePlan(userId);
  const window = usageRepo.currentWindow(subscription);
  const counters = usageRepo.get(userId, window);

  const scanLimit = plan.entitlements.max_scans_per_month;
  const websiteLimit = plan.entitlements.max_websites;
  const websitesUsed = websiteRepo.countActive(userId);

  return {
    window,
    scans: {
      used: counters.scans_used,
      limit: scanLimit,
      remaining: scanLimit === null ? null : Math.max(0, scanLimit - counters.scans_used),
    },
    websites: {
      used: websitesUsed,
      limit: websiteLimit,
      remaining: websiteLimit === null ? null : Math.max(0, websiteLimit - websitesUsed),
    },
    llm_calls: counters.llm_calls,
    scrape_calls: counters.scrape_calls,
    input_tokens: counters.input_tokens,
    output_tokens: counters.output_tokens,
  };
}

/**
 * How many more scans this user may run. `null` means unlimited.
 */
function remainingScans(userId) {
  return getUsage(userId).scans.remaining;
}

/**
 * The payload `/api/auth/me` and the login/signup responses return alongside
 * the user, so the frontend can render gated UI without a second round trip.
 */
function getAccountSummary(userId) {
  const { plan, subscription, inGrace } = resolvePlan(userId);

  return {
    plan: {
      slug: plan.slug,
      name: plan.name,
      price_cents: plan.price_cents,
      currency: plan.currency,
      interval: plan.interval,
    },
    entitlements: plan.entitlements,
    subscription: subscription
      ? {
          status: subscription.status,
          provider: subscription.provider,
          current_period_end: subscription.current_period_end,
          cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
          in_grace_period: inGrace,
        }
      : null,
    usage: getUsage(userId),
  };
}

module.exports = {
  graceDays,
  resolvePlan,
  getEntitlements,
  hasFeature,
  allowedEngines,
  allowedSchedules,
  getUsage,
  remainingScans,
  getAccountSummary,
};
