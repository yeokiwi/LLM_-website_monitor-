/**
 * Billing.
 *
 * Both gateways retry webhook delivery, so idempotency is not a nicety: a
 * replayed event that applies twice means a double plan change or a duplicated
 * payment row. These tests drive the state machine directly, which is the one
 * writer of the subscriptions table, plus the HTTP surface around it.
 */

const request = require('supertest');
const { createTestApp, signup, as } = require('./helpers');

describe('billing', () => {
  let ctx;
  let stateMachine;
  let entitlements;

  beforeAll(() => {
    ctx = createTestApp();
    stateMachine = require('../src/services/billing/stateMachine');
    entitlements = require('../src/services/entitlements');
  });

  afterAll(() => ctx.cleanup());

  const subscriptionEvent = (userId, overrides = {}) => ({
    userId,
    provider: 'stripe',
    status: 'active',
    planSlug: 'pro',
    providerSubId: `sub_${userId}`,
    providerCustomerId: `cus_${userId}`,
    periodStart: new Date().toISOString(),
    periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...overrides,
  });

  describe('plan catalog', () => {
    it('publishes pricing without authentication', async () => {
      const res = await request(ctx.app).get('/api/billing/plans');

      expect(res.status).toBe(200);
      expect(res.body.plans.map((p) => p.slug)).toEqual(['free', 'pro', 'business']);
    });

    it('reports no purchasable plans when no gateway is configured', async () => {
      const res = await request(ctx.app).get('/api/billing/plans');

      expect(res.body.providers).toEqual([]);
      for (const plan of res.body.plans) {
        expect(plan.purchasable_with).toEqual([]);
      }
    });

    it('answers 503, not 500, when checkout is attempted with no gateway', async () => {
      const user = await signup(request, ctx.app, 'nogateway@example.com');

      const res = await as(request(ctx.app).post('/api/billing/checkout'), user.token)
        .send({ planSlug: 'pro', provider: 'stripe' });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not available/i);
    });

    it('rejects an unknown plan', async () => {
      const user = await signup(request, ctx.app, 'badplan@example.com');

      const res = await as(request(ctx.app).post('/api/billing/checkout'), user.token)
        .send({ planSlug: 'enterprise-unicorn', provider: 'stripe' });

      expect(res.status).toBe(400);
    });

    it('refuses checkout for the free plan', async () => {
      const user = await signup(request, ctx.app, 'freecheckout@example.com');

      const res = await as(request(ctx.app).post('/api/billing/checkout'), user.token)
        .send({ planSlug: 'free', provider: 'stripe' });

      expect(res.status).toBe(400);
    });
  });

  describe('webhook idempotency', () => {
    it('processes an event once', () => {
      expect(stateMachine.claimEvent('stripe', 'evt_1', 'test', {})).toBe(true);
    });

    it('skips a redelivery of the same event', () => {
      expect(stateMachine.claimEvent('stripe', 'evt_1', 'test', {})).toBe(false);
    });

    it('treats identical ids from different gateways as distinct', () => {
      expect(stateMachine.claimEvent('paypal', 'evt_1', 'test', {})).toBe(true);
    });

    it('records a payment only once', async () => {
      const user = await signup(request, ctx.app, 'payments@example.com');

      const payment = {
        userId: user.user.id,
        provider: 'stripe',
        providerPaymentId: 'in_duplicate',
        amountCents: 2900,
        currency: 'usd',
        status: 'succeeded',
        paidAt: new Date().toISOString(),
      };

      expect(stateMachine.recordPayment(payment)).toBe(true);
      expect(stateMachine.recordPayment(payment)).toBe(false);

      const rows = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?')
        .get(user.user.id);
      expect(rows.n).toBe(1);
    });
  });

  describe('subscription state machine', () => {
    it('activates a plan and grants its entitlements', async () => {
      const user = await signup(request, ctx.app, 'activate@example.com');
      expect(entitlements.getEntitlements(user.user.id).max_websites).toBe(3);

      stateMachine.applySubscriptionEvent(subscriptionEvent(user.user.id));

      expect(entitlements.getEntitlements(user.user.id).max_websites).toBe(25);

      const me = await as(request(ctx.app).get('/api/auth/me'), user.token);
      expect(me.body.plan.slug).toBe('pro');
      expect(me.body.subscription.status).toBe('active');
    });

    it('updates the existing row rather than stacking subscriptions', async () => {
      const user = await signup(request, ctx.app, 'upgrade@example.com');

      stateMachine.applySubscriptionEvent(subscriptionEvent(user.user.id));
      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { planSlug: 'business' })
      );

      const rows = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?')
        .get(user.user.id);
      expect(rows.n).toBe(1);
      expect(entitlements.getEntitlements(user.user.id).max_websites).toBe(200);
    });

    it('keeps entitlements while a cancellation is pending at period end', async () => {
      const user = await signup(request, ctx.app, 'pending-cancel@example.com');

      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { cancelAtPeriodEnd: true })
      );

      // The customer paid for this period; they keep it until it actually ends.
      expect(entitlements.getEntitlements(user.user.id).max_websites).toBe(25);
      const me = await as(request(ctx.app).get('/api/auth/me'), user.token);
      expect(me.body.subscription.cancel_at_period_end).toBe(true);
    });

    it('drops to Free when the gateway reports the subscription ended', async () => {
      const user = await signup(request, ctx.app, 'ended@example.com');

      stateMachine.applySubscriptionEvent(subscriptionEvent(user.user.id));
      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { status: 'canceled' })
      );

      expect(entitlements.getEntitlements(user.user.id).max_websites).toBe(3);
    });

    it('stamps past_due_since once, so grace runs from the first failure', async () => {
      const user = await signup(request, ctx.app, 'dunning@example.com');

      stateMachine.applySubscriptionEvent(subscriptionEvent(user.user.id));
      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { status: 'past_due' })
      );

      const first = ctx.db
        .prepare('SELECT past_due_since FROM subscriptions WHERE user_id = ?')
        .get(user.user.id).past_due_since;
      expect(first).toBeTruthy();

      // A later retry failure must not restart the clock.
      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { status: 'past_due' })
      );

      const second = ctx.db
        .prepare('SELECT past_due_since FROM subscriptions WHERE user_id = ?')
        .get(user.user.id).past_due_since;
      expect(second).toBe(first);
    });

    it('rejects an unknown status rather than storing it', () => {
      expect(() =>
        stateMachine.applySubscriptionEvent(subscriptionEvent(1, { status: 'confused' }))
      ).toThrow(/Unknown subscription status/);
    });
  });

  describe('downgrade reconciliation', () => {
    it('parks websites over the new cap without deleting them', async () => {
      const user = await signup(request, ctx.app, 'downgrade@example.com');
      stateMachine.applySubscriptionEvent(subscriptionEvent(user.user.id));

      for (let i = 1; i <= 6; i++) {
        await as(request(ctx.app).post('/api/websites'), user.token)
          .send({ url: `https://d${i}.example.com` });
      }

      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { status: 'canceled' })
      );

      const active = await as(request(ctx.app).get('/api/websites'), user.token);
      expect(active.body).toHaveLength(3); // the Free allowance

      // Nothing was destroyed — the parked rows are still there.
      const total = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM websites WHERE owner_id = ?')
        .get(user.user.id);
      expect(total.n).toBe(6);
    });

    it('keeps the oldest websites, which are the ones with history', async () => {
      const user = await signup(request, ctx.app, 'keep-oldest@example.com');
      stateMachine.applySubscriptionEvent(subscriptionEvent(user.user.id));

      for (let i = 1; i <= 5; i++) {
        await as(request(ctx.app).post('/api/websites'), user.token)
          .send({ url: `https://k${i}.example.com`, name: `Site ${i}` });
        // created_at has one-second resolution in SQLite, so order the rows
        // explicitly rather than relying on insertion timing.
        ctx.db
          .prepare("UPDATE websites SET created_at = datetime('now', ?) WHERE url = ?")
          .run(`-${10 - i} hours`, `https://k${i}.example.com`);
      }

      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { status: 'canceled' })
      );

      const active = await as(request(ctx.app).get('/api/websites'), user.token);
      const names = active.body.map((w) => w.name).sort();
      expect(names).toEqual(['Site 1', 'Site 2', 'Site 3']);
    });

    it('switches off schedules the new plan does not allow', async () => {
      const user = await signup(request, ctx.app, 'sched-downgrade@example.com');
      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { planSlug: 'business' })
      );

      const site = (
        await as(request(ctx.app).post('/api/websites'), user.token)
          .send({ url: 'https://hourly.example.com' })
      ).body;

      await as(request(ctx.app).put(`/api/schedules/${site.id}`), user.token)
        .send({ frequency: 'hourly' });

      stateMachine.applySubscriptionEvent(
        subscriptionEvent(user.user.id, { planSlug: 'pro' })
      );

      const schedule = ctx.db
        .prepare('SELECT is_enabled FROM schedules WHERE website_id = ?')
        .get(site.id);
      expect(schedule.is_enabled).toBe(0);
    });
  });

  describe('webhook endpoints', () => {
    it('rejects a Stripe webhook with no signature', async () => {
      const res = await request(ctx.app)
        .post('/api/billing/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send({ id: 'evt_forged', type: 'invoice.paid' });

      expect(res.status).toBe(400);
    });

    it('rejects a PayPal webhook that cannot be verified', async () => {
      const res = await request(ctx.app)
        .post('/api/billing/webhooks/paypal')
        .send({ id: 'WH_forged', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED' });

      expect(res.status).toBe(400);
    });

    it('does not apply an unverified event', () => {
      const seen = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = ?')
        .get('evt_forged');
      expect(seen.n).toBe(0);
    });
  });

  describe('Stripe event normalisation', () => {
    it('maps a subscription event onto the internal shape', async () => {
      const user = await signup(request, ctx.app, 'normalise@example.com');
      const stripe = require('../src/services/billing/stripe');

      const normalised = stripe.normalizeEvent({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_abc',
            status: 'past_due',
            customer: 'cus_abc',
            metadata: { userId: String(user.user.id) },
            current_period_start: 1_700_000_000,
            current_period_end: 1_702_592_000,
            cancel_at_period_end: false,
            items: { data: [{ price: { id: 'price_missing' } }] },
          },
        },
      });

      expect(normalised.subscription.userId).toBe(user.user.id);
      expect(normalised.subscription.status).toBe('past_due');
      expect(normalised.subscription.providerSubId).toBe('sub_abc');
      expect(normalised.subscription.periodEnd).toBe('2023-12-14T22:13:20.000Z');
    });

    it('maps a failed invoice to a failed payment', async () => {
      const user = await signup(request, ctx.app, 'failed-invoice@example.com');
      const stripe = require('../src/services/billing/stripe');

      const normalised = stripe.normalizeEvent({
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_failed',
            customer: 'cus_x',
            metadata: { userId: String(user.user.id) },
            amount_due: 2900,
            currency: 'usd',
          },
        },
      });

      expect(normalised.payment.status).toBe('failed');
      expect(normalised.payment.amountCents).toBe(2900);
    });

    it('ignores an event it cannot attribute to an account', () => {
      const stripe = require('../src/services/billing/stripe');

      const normalised = stripe.normalizeEvent({
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_orphan', status: 'active', customer: 'cus_unknown' } },
      });

      expect(normalised).toBeNull();
    });
  });

  describe('PayPal event normalisation', () => {
    it('maps an activation via custom_id', async () => {
      const user = await signup(request, ctx.app, 'paypal-activate@example.com');
      const paypal = require('../src/services/billing/paypal');

      const normalised = paypal.normalizeEvent({
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: {
          id: 'I-PAYPALSUB1',
          status: 'ACTIVE',
          custom_id: String(user.user.id),
          subscriber: { payer_id: 'PAYER1' },
          billing_info: { next_billing_time: '2026-01-01T00:00:00Z' },
        },
      });

      expect(normalised.subscription.userId).toBe(user.user.id);
      expect(normalised.subscription.status).toBe('active');
      expect(normalised.subscription.providerSubId).toBe('I-PAYPALSUB1');
    });

    it('maps a suspension to past_due so the grace window applies', async () => {
      const user = await signup(request, ctx.app, 'paypal-suspend@example.com');
      const paypal = require('../src/services/billing/paypal');

      const normalised = paypal.normalizeEvent({
        event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
        resource: { id: 'I-SUSPENDED', status: 'SUSPENDED', custom_id: String(user.user.id) },
      });

      expect(normalised.subscription.status).toBe('past_due');
    });

    it('attributes a sale through billing_agreement_id, not the sale id', async () => {
      const user = await signup(request, ctx.app, 'paypal-sale@example.com');
      const paypal = require('../src/services/billing/paypal');

      // Store the subscription first, as an activation webhook would.
      stateMachine.applySubscriptionEvent(
        paypal.normalizeEvent({
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: 'I-SALESUB', status: 'ACTIVE', custom_id: String(user.user.id) },
        }).subscription
      );

      // A sale carries no custom_id, and its `id` is the sale's own id — the
      // subscription is only named in billing_agreement_id.
      const normalised = paypal.normalizeEvent({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: 'SALE-XYZ',
          billing_agreement_id: 'I-SALESUB',
          amount: { total: '29.00', currency: 'USD' },
          create_time: '2025-06-01T00:00:00Z',
        },
      });

      expect(normalised.payment.userId).toBe(user.user.id);
      expect(normalised.payment.amountCents).toBe(2900);
      expect(normalised.payment.currency).toBe('usd');
    });

    it('maps a refund to a negative amount', async () => {
      const user = await signup(request, ctx.app, 'paypal-refund@example.com');
      const paypal = require('../src/services/billing/paypal');

      stateMachine.applySubscriptionEvent(
        paypal.normalizeEvent({
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: 'I-REFUNDSUB', status: 'ACTIVE', custom_id: String(user.user.id) },
        }).subscription
      );

      const normalised = paypal.normalizeEvent({
        event_type: 'PAYMENT.SALE.REFUNDED',
        resource: {
          id: 'REFUND-1',
          billing_agreement_id: 'I-REFUNDSUB',
          amount: { total: '29.00', currency: 'USD' },
        },
      });

      expect(normalised.payment.status).toBe('refunded');
      expect(normalised.payment.amountCents).toBe(-2900);
    });

    it('ignores an event it cannot attribute to an account', () => {
      const paypal = require('../src/services/billing/paypal');

      const normalised = paypal.normalizeEvent({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: { id: 'SALE-ORPHAN', billing_agreement_id: 'I-UNKNOWN' },
      });

      expect(normalised).toBeNull();
    });
  });
});
