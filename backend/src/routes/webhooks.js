/**
 * Payment gateway webhooks.
 *
 * Mounted BEFORE the global `express.json()` parser: Stripe signs the exact
 * bytes it sent, so the body must reach `constructEvent` unparsed. Each route
 * therefore installs its own body parser.
 *
 * Both gateways retry delivery, so every event is claimed through
 * `webhook_events` first — a replay is recorded and skipped rather than applied
 * twice.
 */

const express = require('express');

const stripeProvider = require('../services/billing/stripe');
const paypalProvider = require('../services/billing/paypal');
const stateMachine = require('../services/billing/stateMachine');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const userRepo = require('../repositories/userRepo');
const mailer = require('../services/mailer');
const emails = require('../services/emails');

const router = express.Router();

/**
 * Apply a normalised event's subscription and payment parts.
 * Shared by both gateways so their handling cannot drift apart.
 */
async function applyNormalized(normalized) {
  if (!normalized) return;

  let subscription = null;

  if (normalized.subscription) {
    subscription = stateMachine.applySubscriptionEvent(normalized.subscription);
  }

  if (normalized.payment) {
    const payment = normalized.payment;
    const live = subscription || subscriptionRepo.findLiveForUser(payment.userId);

    const inserted = stateMachine.recordPayment({
      ...payment,
      subscriptionId: live?.id || null,
    });

    if (inserted) {
      await notifyPayment(payment);
    }
  }
}

async function notifyPayment(payment) {
  const user = userRepo.findById(payment.userId);
  if (!user || !user.notify_billing) return;

  if (payment.status === 'succeeded') {
    await mailer.send({ to: user.email, ...emails.paymentReceipt(payment) });
  } else if (payment.status === 'failed') {
    await mailer.send({ to: user.email, ...emails.paymentFailed(payment) });
  }
}

// ---------------------------------------------------------------------------
// POST /api/billing/webhooks/stripe
// ---------------------------------------------------------------------------
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = stripeProvider.verifyWebhook(req.body, req.headers['stripe-signature']);
    } catch (err) {
      console.error('Stripe webhook verification failed:', err.message);
      return res.status(400).json({ error: 'Signature verification failed' });
    }

    // Acknowledge before processing: Stripe retries on a slow response, and a
    // duplicate delivery is cheap now that events are deduplicated.
    if (!stateMachine.claimEvent('stripe', event.id, event.type, event)) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      await applyNormalized(stripeProvider.normalizeEvent(event));
      stateMachine.markEventProcessed('stripe', event.id, null);
    } catch (err) {
      console.error(`Failed to process Stripe event ${event.id}:`, err);
      stateMachine.markEventProcessed('stripe', event.id, err.message);
    }

    res.json({ received: true });
  }
);

// ---------------------------------------------------------------------------
// POST /api/billing/webhooks/paypal
// ---------------------------------------------------------------------------
router.post(
  '/paypal',
  express.json({ type: () => true }),
  async (req, res) => {
    let event;
    try {
      event = await paypalProvider.verifyWebhook(req.body, req.headers);
    } catch (err) {
      console.error('PayPal webhook verification failed:', err.message);
      return res.status(400).json({ error: 'Signature verification failed' });
    }

    if (!stateMachine.claimEvent('paypal', event.id, event.event_type, event)) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      await applyNormalized(paypalProvider.normalizeEvent(event));
      stateMachine.markEventProcessed('paypal', event.id, null);
    } catch (err) {
      console.error(`Failed to process PayPal event ${event.id}:`, err);
      stateMachine.markEventProcessed('paypal', event.id, err.message);
    }

    res.json({ received: true });
  }
);

module.exports = router;
