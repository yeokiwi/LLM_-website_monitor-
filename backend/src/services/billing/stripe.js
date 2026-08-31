/**
 * Stripe adapter.
 *
 * Checkout Sessions handle subscribe; the Billing Portal handles upgrade,
 * downgrade, cancel and payment-method changes. That deliberately keeps card
 * UI out of this codebase — no card data ever reaches the server, which keeps
 * the deployment in PCI SAQ-A scope.
 */

const Stripe = require('stripe');

const planRepo = require('../../repositories/planRepo');
const subscriptionRepo = require('../../repositories/subscriptionRepo');
const userRepo = require('../../repositories/userRepo');
const { appUrl } = require('../mailer');

let client;

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function stripe() {
  if (!isConfigured()) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY is unset)');
  }
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

/** Stripe's subscription statuses mapped onto the internal vocabulary. */
const STATUS_MAP = {
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  paused: 'canceled',
};

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/**
 * Reuse the customer we already created for this user, or make one. Reusing it
 * keeps a returning subscriber's payment methods and invoice history together.
 */
async function ensureCustomer(user) {
  const existing = subscriptionRepo.findProviderCustomerId(user.id, 'stripe');
  if (existing) return existing;

  const customer = await stripe().customers.create({
    email: user.email,
    name: user.name || undefined,
    metadata: { userId: String(user.id) },
  });

  return customer.id;
}

/**
 * Start a subscription checkout.
 * @returns {Promise<{ url: string }>}
 */
async function createCheckout({ user, plan }) {
  if (!plan.stripe_price_id) {
    throw new Error(`Plan "${plan.slug}" has no Stripe price configured`);
  }

  const customerId = await ensureCustomer(user);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    // Carried through to the subscription so webhooks can attribute events to
    // an account without a lookup table.
    subscription_data: {
      metadata: { userId: String(user.id), planSlug: plan.slug },
    },
    metadata: { userId: String(user.id), planSlug: plan.slug },
    client_reference_id: String(user.id),
    success_url: `${appUrl()}/account/billing?checkout=success`,
    cancel_url: `${appUrl()}/pricing?checkout=cancelled`,
    allow_promotion_codes: true,
  });

  return { url: session.url };
}

/** A Billing Portal session for self-serve plan changes and cancellation. */
async function createPortalSession({ user }) {
  const customerId = subscriptionRepo.findProviderCustomerId(user.id, 'stripe');
  if (!customerId) {
    throw new Error('No Stripe customer exists for this account');
  }

  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl()}/account/billing`,
  });

  return { url: session.url };
}

/** Cancel at period end so the customer keeps what they have paid for. */
async function cancel({ subscription }) {
  if (!subscription?.provider_sub_id) {
    throw new Error('No active Stripe subscription to cancel');
  }
  await stripe().subscriptions.update(subscription.provider_sub_id, {
    cancel_at_period_end: true,
  });
}

/**
 * Verify a webhook signature and return the Stripe event.
 * @param {Buffer} rawBody the untouched request body
 */
function verifyWebhook(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}

/** Resolve the account an event belongs to, via metadata then customer id. */
function resolveUserId(object) {
  const fromMetadata =
    object?.metadata?.userId || object?.subscription_details?.metadata?.userId;
  if (fromMetadata) {
    const user = userRepo.findById(parseInt(fromMetadata, 10));
    if (user) return user.id;
  }

  const customerId = typeof object?.customer === 'string' ? object.customer : null;
  return subscriptionRepo.findUserIdByCustomerId('stripe', customerId);
}

function planSlugForSubscription(subscription) {
  const priceId = subscription?.items?.data?.[0]?.price?.id;
  const plan = planRepo.getByStripePriceId(priceId);
  return plan?.slug || subscription?.metadata?.planSlug || null;
}

/**
 * Convert a Stripe event into the internal shape.
 * @returns {{ subscription?: object, payment?: object } | null}
 */
function normalizeEvent(event) {
  const object = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      // The subscription.created/updated events carry the authoritative state;
      // this one exists mainly to bind the customer id to the account early.
      const userId = resolveUserId(object);
      if (!userId || object.mode !== 'subscription') return null;

      return {
        subscription: {
          userId,
          provider: 'stripe',
          status: 'incomplete',
          planSlug: object.metadata?.planSlug || null,
          providerSubId:
            typeof object.subscription === 'string' ? object.subscription : null,
          providerCustomerId:
            typeof object.customer === 'string' ? object.customer : null,
        },
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = resolveUserId(object);
      if (!userId) return null;

      const status =
        event.type === 'customer.subscription.deleted'
          ? 'canceled'
          : STATUS_MAP[object.status] || 'canceled';

      return {
        subscription: {
          userId,
          provider: 'stripe',
          status,
          planSlug: planSlugForSubscription(object),
          providerSubId: object.id,
          providerCustomerId:
            typeof object.customer === 'string' ? object.customer : null,
          periodStart: toIso(object.current_period_start),
          periodEnd: toIso(object.current_period_end),
          cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
          trialEnd: toIso(object.trial_end),
        },
      };
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const userId = resolveUserId(object);
      if (!userId) return null;

      const succeeded = event.type === 'invoice.paid';

      return {
        payment: {
          userId,
          provider: 'stripe',
          providerPaymentId: object.id,
          amountCents: succeeded ? object.amount_paid : object.amount_due,
          currency: object.currency,
          status: succeeded ? 'succeeded' : 'failed',
          invoiceUrl: object.hosted_invoice_url || null,
          paidAt: succeeded ? toIso(object.status_transitions?.paid_at) : null,
        },
      };
    }

    case 'charge.refunded': {
      const userId = resolveUserId(object);
      if (!userId) return null;

      return {
        payment: {
          userId,
          provider: 'stripe',
          providerPaymentId: `${object.id}:refund`,
          amountCents: -(object.amount_refunded || 0),
          currency: object.currency,
          status: 'refunded',
          paidAt: toIso(object.created),
        },
      };
    }

    default:
      return null;
  }
}

module.exports = {
  name: 'stripe',
  isConfigured,
  createCheckout,
  createPortalSession,
  cancel,
  verifyWebhook,
  normalizeEvent,
  ensureCustomer,
};
