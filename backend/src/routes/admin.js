/**
 * Platform operator views. Mounted behind requireSuperadmin — this is the only
 * place in the API where data crosses tenant boundaries.
 */

const express = require('express');

const db = require('../db');
const userRepo = require('../repositories/userRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const usageRepo = require('../repositories/usageRepo');
const planRepo = require('../repositories/planRepo');

const router = express.Router();

function pagination(req) {
  return {
    limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
    offset: parseInt(req.query.offset, 10) || 0,
  };
}

// GET /api/admin/users
router.get('/users', (req, res) => {
  const { limit, offset } = pagination(req);
  res.json({
    total: userRepo.countAll(),
    limit,
    offset,
    users: userRepo.listAll(limit, offset),
  });
});

// GET /api/admin/subscriptions
router.get('/subscriptions', (req, res) => {
  const { limit, offset } = pagination(req);
  res.json({ limit, offset, subscriptions: subscriptionRepo.listAll(limit, offset) });
});

// GET /api/admin/stats — platform totals for the current calendar month
router.get('/stats', (req, res) => {
  const window = usageRepo.currentWindow(null);

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users)                                AS users,
         (SELECT COUNT(*) FROM websites WHERE is_active = 1)         AS active_websites,
         (SELECT COUNT(*) FROM scan_results)                         AS scans_all_time,
         (SELECT COUNT(*) FROM schedules WHERE is_enabled = 1)       AS active_schedules,
         (SELECT COUNT(*) FROM subscriptions
           WHERE status IN ('trialing','active','past_due'))         AS live_subscriptions`
    )
    .get();

  const revenue = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents, currency
         FROM payments
        WHERE status = 'succeeded' AND paid_at >= ?
        GROUP BY currency`
    )
    .all(`${window.periodStart}T00:00:00Z`);

  const byPlan = db
    .prepare(
      `SELECT p.slug, p.name, COUNT(s.id) AS subscribers
         FROM plans p
         LEFT JOIN subscriptions s
           ON s.plan_id = p.id AND s.status IN ('trialing','active','past_due')
        GROUP BY p.id
        ORDER BY p.sort_order`
    )
    .all();

  res.json({
    window,
    counts,
    usage: usageRepo.totalsForWindow(window),
    revenue_this_period: revenue,
    subscribers_by_plan: byPlan,
    plans: planRepo.listActive().map((p) => ({
      slug: p.slug,
      name: p.name,
      price_cents: p.price_cents,
      stripe_price_id: p.stripe_price_id,
      paypal_plan_id: p.paypal_plan_id,
    })),
  });
});

module.exports = router;
