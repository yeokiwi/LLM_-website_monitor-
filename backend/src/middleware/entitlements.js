/**
 * Plan enforcement middleware.
 *
 * Every rejection is **402 Payment Required** with a machine-readable `code`,
 * so the frontend can tell "you need a bigger plan" apart from "you are not
 * signed in" (401) and "this is not yours" (403/404), and show an upgrade
 * prompt instead of a generic error.
 */

const entitlements = require('../services/entitlements');
const planRepo = require('../repositories/planRepo');

/** The cheapest active plan that unlocks `feature`, for the upgrade prompt. */
function suggestPlanFor(predicate) {
  const plan = planRepo
    .listActive()
    .sort((a, b) => a.price_cents - b.price_cents)
    .find((p) => predicate(p.entitlements));
  return plan ? { slug: plan.slug, name: plan.name } : null;
}

function featureLocked(res, feature, message) {
  return res.status(402).json({
    error: message,
    code: 'FEATURE_LOCKED',
    feature,
    upgradeTo: suggestPlanFor((e) => e[feature] === true),
  });
}

/** Gate a boolean feature, e.g. `requireFeature('pdf_export')`. */
function requireFeature(feature, label) {
  return (req, res, next) => {
    if (entitlements.hasFeature(req.user.userId, feature)) return next();
    return featureLocked(
      res,
      feature,
      `${label || 'This feature'} is not included in your current plan`
    );
  };
}

/**
 * Gate the number of monitored websites.
 *
 * `additional` is how many the request is about to add — bulk imports check the
 * whole batch up front rather than inserting until the wall is hit.
 */
function requireWebsiteQuota(getAdditional = () => 1) {
  return (req, res, next) => {
    const usage = entitlements.getUsage(req.user.userId);
    const { limit, used } = usage.websites;

    if (limit === null) return next();

    const additional = Math.max(1, getAdditional(req));

    if (used + additional > limit) {
      return res.status(402).json({
        error:
          `Your plan allows ${limit} monitored website${limit === 1 ? '' : 's'} ` +
          `and you are using ${used}.`,
        code: 'QUOTA_EXCEEDED',
        quota: 'websites',
        limit,
        used,
        requested: additional,
        upgradeTo: suggestPlanFor(
          (e) => e.max_websites === null || e.max_websites > limit
        ),
      });
    }

    next();
  };
}

/**
 * Gate scans for the current billing period.
 *
 * The whole batch is checked before any scan runs, so a request either fits or
 * is rejected — it never half-drains the allowance and leaves the customer
 * wondering which sites were scanned.
 */
function requireScanQuota(getRequested = () => 1) {
  return (req, res, next) => {
    const usage = entitlements.getUsage(req.user.userId);
    const { limit, used, remaining } = usage.scans;

    if (limit === null) return next();

    const requested = Math.max(1, getRequested(req));

    if (requested > remaining) {
      return res.status(402).json({
        error:
          remaining === 0
            ? `You have used all ${limit} scans included in your plan this period.`
            : `This would use ${requested} scans but only ${remaining} remain this period.`,
        code: 'QUOTA_EXCEEDED',
        quota: 'scans',
        limit,
        used,
        remaining,
        requested,
        periodEnd: usage.window.periodEnd,
        upgradeTo: suggestPlanFor(
          (e) => e.max_scans_per_month === null || e.max_scans_per_month > limit
        ),
      });
    }

    next();
  };
}

module.exports = {
  requireFeature,
  requireWebsiteQuota,
  requireScanQuota,
  suggestPlanFor,
};
