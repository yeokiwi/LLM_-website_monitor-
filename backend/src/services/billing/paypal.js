/**
 * PayPal adapter.
 *
 * Uses the REST Subscriptions API directly over axios rather than an SDK — the
 * surface needed here is four calls, and this keeps the dependency list and the
 * auth flow explicit.
 *
 * PayPal has no equivalent of Stripe's Billing Portal, so cancellation is an
 * API call made from our own billing page, and a plan change is cancel plus
 * re-subscribe.
 */

const axios = require('axios');

const planRepo = require('../../repositories/planRepo');
const subscriptionRepo = require('../../repositories/subscriptionRepo');
const userRepo = require('../../repositories/userRepo');
const { appUrl } = require('../mailer');

const LIVE_BASE = 'https://api-m.paypal.com';
const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

let cachedToken = null; // { value, expiresAt }

function isConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function apiBase() {
  return /^live$/i.test(process.env.PAYPAL_ENV || 'sandbox') ? LIVE_BASE : SANDBOX_BASE;
}

/** OAuth2 client-credentials token, cached until shortly before it expires. */
async function accessToken() {
  if (!isConfigured()) {
    throw new Error('PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const { data } = await axios.post(
    `${apiBase()}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: {
        username: process.env.PAYPAL_CLIENT_ID,
        password: process.env.PAYPAL_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20_000,
    }
  );

  cachedToken = {
    value: data.access_token,
    // Refresh a minute early so a token never expires mid-request.
    expiresAt: Date.now() + Math.max(0, (data.expires_in - 60) * 1000),
  };

  return cachedToken.value;
}

async function request(method, path, body) {
  const token = await accessToken();
  const { data } = await axios({
    method,
    url: `${apiBase()}${path}`,
    data: body,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
  return data;
}

/** PayPal's subscription statuses mapped onto the internal vocabulary. */
const STATUS_MAP = {
  APPROVAL_PENDING: 'incomplete',
  APPROVED: 'incomplete',
  ACTIVE: 'active',
  SUSPENDED: 'past_due',
  CANCELLED: 'canceled',
  EXPIRED: 'canceled',
};

/**
 * Create a subscription and return its approval URL.
 *
 * `custom_id` carries our user id through PayPal so webhooks can be attributed
 * without a lookup table.
 */
async function createCheckout({ user, plan }) {
  if (!plan.paypal_plan_id) {
    throw new Error(`Plan "${plan.slug}" has no PayPal plan configured`);
  }

  const subscription = await request('post', '/v1/billing/subscriptions', {
    plan_id: plan.paypal_plan_id,
    custom_id: String(user.id),
    subscriber: {
      email_address: user.email,
      name: user.name ? { given_name: user.name } : undefined,
    },
    application_context: {
      brand_name: 'Website Monitor',
      user_action: 'SUBSCRIBE_NOW',
      return_url: `${appUrl()}/account/billing?paypal=success`,
      cancel_url: `${appUrl()}/pricing?paypal=cancelled`,
    },
  });

  const approval = (subscription.links || []).find((l) => l.rel === 'approve');
  if (!approval) {
    throw new Error('PayPal did not return an approval link');
  }

  return { url: approval.href, providerSubId: subscription.id };
}

/** Read a subscription's current state — used after the approval redirect. */
async function getSubscription(subscriptionId) {
  return request('get', `/v1/billing/subscriptions/${subscriptionId}`);
}

async function cancel({ subscription }) {
  if (!subscription?.provider_sub_id) {
    throw new Error('No active PayPal subscription to cancel');
  }
  await request('post', `/v1/billing/subscriptions/${subscription.provider_sub_id}/cancel`, {
    reason: 'Cancelled by the subscriber',
  });
}

/**
 * Verify a webhook using PayPal's verification endpoint.
 *
 * Unlike Stripe there is no local HMAC to check — the payload and its transmission
 * headers are posted back to PayPal, which answers SUCCESS or FAILURE.
 *
 * @returns {Promise<object>} the event body when verification succeeds
 */
async function verifyWebhook(body, headers) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    throw new Error('PAYPAL_WEBHOOK_ID is not configured');
  }

  const result = await request('post', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: body,
  });

  if (result.verification_status !== 'SUCCESS') {
    throw new Error('PayPal webhook signature verification failed');
  }

  return body;
}

/** Resolve the account an event belongs to, via custom_id then subscription id. */
function resolveUserId(resource) {
  const customId = resource?.custom_id || resource?.billing_agreement_id;

  if (resource?.custom_id) {
    const user = userRepo.findById(parseInt(resource.custom_id, 10));
    if (user) return user.id;
  }

  const subId = resource?.id || resource?.billing_agreement_id;
  const existing = subscriptionRepo.findByProviderSubId('paypal', subId);
  if (existing) return existing.user_id;

  // PAYMENT.SALE.* carries the subscription id under billing_agreement_id.
  if (customId && customId !== resource?.custom_id) {
    const bySub = subscriptionRepo.findByProviderSubId('paypal', customId);
    if (bySub) return bySub.user_id;
  }

  return null;
}

function planSlugFor(resource) {
  const plan = planRepo.getByPaypalPlanId(resource?.plan_id);
  return plan?.slug || null;
}

/** Convert a PayPal webhook event into the internal shape. */
function normalizeEvent(event) {
  const resource = event.resource || {};

  switch (event.event_type) {
    case 'BILLING.SUBSCRIPTION.CREATED':
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.UPDATED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      const userId = resolveUserId(resource);
      if (!userId) return null;

      return {
        subscription: {
          userId,
          provider: 'paypal',
          status: STATUS_MAP[resource.status] || 'canceled',
          planSlug: planSlugFor(resource),
          providerSubId: resource.id,
          providerCustomerId: resource.subscriber?.payer_id || null,
          periodStart: resource.billing_info?.last_payment?.time || null,
          periodEnd: resource.billing_info?.next_billing_time || null,
          cancelAtPeriodEnd: false,
        },
      };
    }

    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
      const userId = resolveUserId(resource);
      if (!userId) return null;

      return {
        subscription: {
          userId,
          provider: 'paypal',
          status: 'past_due',
          planSlug: planSlugFor(resource),
          providerSubId: resource.id,
        },
      };
    }

    case 'PAYMENT.SALE.COMPLETED': {
      const userId = resolveUserId(resource);
      if (!userId) return null;

      return {
        payment: {
          userId,
          provider: 'paypal',
          providerPaymentId: resource.id,
          amountCents: Math.round(parseFloat(resource.amount?.total || '0') * 100),
          currency: (resource.amount?.currency || 'usd').toLowerCase(),
          status: 'succeeded',
          paidAt: resource.create_time || null,
        },
      };
    }

    case 'PAYMENT.SALE.REFUNDED': {
      const userId = resolveUserId(resource);
      if (!userId) return null;

      return {
        payment: {
          userId,
          provider: 'paypal',
          providerPaymentId: `${resource.id}:refund`,
          amountCents: -Math.round(parseFloat(resource.amount?.total || '0') * 100),
          currency: (resource.amount?.currency || 'usd').toLowerCase(),
          status: 'refunded',
          paidAt: resource.create_time || null,
        },
      };
    }

    default:
      return null;
  }
}

/**
 * Turn a live PayPal subscription resource into a normalised event.
 * Used by the post-approval activation endpoint, where there is no webhook to
 * wait for before showing the customer their new plan.
 */
function normalizeSubscriptionResource(userId, resource) {
  return {
    userId,
    provider: 'paypal',
    status: STATUS_MAP[resource.status] || 'incomplete',
    planSlug: planSlugFor(resource),
    providerSubId: resource.id,
    providerCustomerId: resource.subscriber?.payer_id || null,
    periodStart: resource.billing_info?.last_payment?.time || null,
    periodEnd: resource.billing_info?.next_billing_time || null,
    cancelAtPeriodEnd: false,
  };
}

module.exports = {
  name: 'paypal',
  isConfigured,
  apiBase,
  request,
  createCheckout,
  getSubscription,
  cancel,
  verifyWebhook,
  normalizeEvent,
  normalizeSubscriptionResource,
};
