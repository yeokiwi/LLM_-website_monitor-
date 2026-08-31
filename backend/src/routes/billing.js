/**
 * Billing — plan catalog, checkout, portal, cancellation and invoices.
 *
 * Webhooks live in routes/webhooks.js because they must be mounted before the
 * global JSON body parser to keep the raw body for signature verification.
 */

const express = require('express');

const planRepo = require('../repositories/planRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const billing = require('../services/billing');
const stateMachine = require('../services/billing/stateMachine');
const paypal = require('../services/billing/paypal');
const entitlements = require('../services/entitlements');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/billing/plans — public pricing page data
// ---------------------------------------------------------------------------
router.get('/plans', (req, res) => {
  const providers = billing.availableProviders();

  res.json({
    providers,
    plans: planRepo.listActive().map((plan) => ({
      slug: plan.slug,
      name: plan.name,
      price_cents: plan.price_cents,
      currency: plan.currency,
      interval: plan.interval,
      entitlements: plan.entitlements,
      // A paid plan is only purchasable where the gateway has an id for it.
      purchasable_with: plan.price_cents === 0
        ? []
        : providers.filter((p) =>
            p === 'stripe' ? Boolean(plan.stripe_price_id) : Boolean(plan.paypal_plan_id)
          ),
    })),
  });
});

// Everything below needs an account.
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/billing/subscription — current plan, usage and invoices
// ---------------------------------------------------------------------------
router.get('/subscription', (req, res) => {
  res.json({
    ...entitlements.getAccountSummary(req.user.userId),
    providers: billing.availableProviders(),
    payments: stateMachine.listPayments(req.user.userId),
  });
});

// ---------------------------------------------------------------------------
// POST /api/billing/checkout — start a subscription
// Body: { planSlug: string, provider: 'stripe'|'paypal' }
// ---------------------------------------------------------------------------
router.post('/checkout', async (req, res, next) => {
  const { planSlug, provider } = req.body;

  const plan = planRepo.getBySlug(planSlug);
  if (!plan || !plan.is_active) {
    return res.status(400).json({ error: 'Unknown plan' });
  }
  if (plan.price_cents === 0) {
    return res.status(400).json({ error: 'The free plan does not require checkout' });
  }

  try {
    const gateway = billing.getProvider(provider);
    const { url } = await gateway.createCheckout({ user: req.user.record, plan });
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/portal — Stripe Billing Portal session
// ---------------------------------------------------------------------------
router.post('/portal', async (req, res, next) => {
  try {
    const gateway = billing.getProvider('stripe');
    const { url } = await gateway.createPortalSession({ user: req.user.record });
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/paypal/activate — finalise after the approval redirect
// Body: { subscriptionId: string }
//
// The webhook is authoritative, but it can lag the redirect by seconds. Reading
// the subscription back here means the customer sees their new plan
// immediately; both paths converge on the same state machine.
// ---------------------------------------------------------------------------
router.post('/paypal/activate', async (req, res, next) => {
  const { subscriptionId } = req.body;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId is required' });
  }

  try {
    billing.getProvider('paypal');
    const resource = await paypal.getSubscription(subscriptionId);

    // Only accept a subscription this account actually started.
    if (String(resource.custom_id) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'That subscription belongs to another account' });
    }

    stateMachine.applySubscriptionEvent(
      paypal.normalizeSubscriptionResource(req.user.userId, resource)
    );

    res.json(entitlements.getAccountSummary(req.user.userId));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/cancel — cancel at the end of the paid period
// ---------------------------------------------------------------------------
router.post('/cancel', async (req, res, next) => {
  const subscription = subscriptionRepo.findLiveForUser(req.user.userId);

  if (!subscription || !subscription.provider) {
    return res.status(400).json({ error: 'There is no active subscription to cancel' });
  }

  try {
    const gateway = billing.getProvider(subscription.provider);
    await gateway.cancel({ subscription });

    // Stripe keeps the subscription active until the period ends; PayPal
    // cancels immediately. Reflect each accurately rather than guessing —
    // the webhook will confirm either way.
    if (subscription.provider === 'stripe') {
      subscriptionRepo.update(subscription.id, { cancel_at_period_end: 1 });
    } else {
      stateMachine.applySubscriptionEvent({
        userId: req.user.userId,
        provider: 'paypal',
        status: 'canceled',
        providerSubId: subscription.provider_sub_id,
      });
    }

    res.json(entitlements.getAccountSummary(req.user.userId));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
