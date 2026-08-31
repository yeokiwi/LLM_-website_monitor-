/**
 * Billing provider registry.
 *
 * Both gateways expose the same surface, so routes never branch on provider
 * beyond picking one out of this map.
 */

const stripe = require('./stripe');
const paypal = require('./paypal');
const stateMachine = require('./stateMachine');

const PROVIDERS = { stripe, paypal };

/**
 * Look up a configured gateway.
 *
 * Errors carry an HTTP status so the route's error handler answers "this
 * deployment cannot take payments" rather than leaking a 500 and a stack trace
 * at a customer trying to pay.
 */
function getProvider(name) {
  const provider = PROVIDERS[name];

  if (!provider) {
    const err = new Error(`Unknown payment provider: ${name}`);
    err.status = 400;
    throw err;
  }

  if (!provider.isConfigured()) {
    const err = new Error(
      `Payments through ${provider.name} are not available on this deployment`
    );
    err.status = 503;
    throw err;
  }

  return provider;
}

/** Which gateways this deployment can actually take money through. */
function availableProviders() {
  return Object.values(PROVIDERS)
    .filter((p) => p.isConfigured())
    .map((p) => p.name);
}

/** Is any payment gateway configured at all? */
function billingEnabled() {
  return availableProviders().length > 0;
}

module.exports = { PROVIDERS, getProvider, availableProviders, billingEnabled, stateMachine };
