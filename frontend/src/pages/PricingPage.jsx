import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getPlans, startCheckout, errorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import s from './PricingPage.module.css';

const PROVIDER_LABELS = { stripe: 'Card', paypal: 'PayPal' };

function formatPrice(cents, currency) {
  if (cents === 0) return 'Free';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

const limit = (value, singular, plural) =>
  value === null ? `Unlimited ${plural}` : `${value} ${value === 1 ? singular : plural}`;

const ENGINE_NAMES = {
  firecrawl: 'Firecrawl',
  brave: 'Brave',
  serper: 'Serper',
  direct: 'Direct',
};

/** "a", "a and b", "a, b and c" */
function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Turn a plan's entitlements into the bullet list a buyer actually reads. */
function featureList(e) {
  const engines = (e.engines || []).filter((x) => x !== 'direct');
  const schedules = e.schedules || [];

  return [
    limit(e.max_websites, 'monitored website', 'monitored websites'),
    `${e.max_scans_per_month === null ? 'Unlimited' : e.max_scans_per_month} scans per month`,
    engines.length
      ? `Premium sources (${joinList(engines.map((x) => ENGINE_NAMES[x] || x))})`
      : 'Direct page scraping',
    schedules.length
      ? `Automatic ${joinList(schedules)} scans`
      : 'Manual scans',
    e.email_alerts ? 'Email alerts when something changes' : null,
    e.pdf_export ? 'PDF report export' : null,
    e.excel_import_export ? 'Spreadsheet import and export' : null,
    e.db_backup ? 'Full data export' : null,
    e.history_retention_days === null
      ? 'Unlimited history'
      : `${e.history_retention_days} days of history`,
  ].filter(Boolean);
}

export default function PricingPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null); // `${slug}:${provider}` while redirecting

  const { isAuthenticated, plan: currentPlan } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    getPlans()
      .then(setData)
      .catch((err) => setError(errorMessage(err, 'Could not load plans')));
  }, []);

  async function handleSubscribe(slug, provider) {
    if (!isAuthenticated) {
      navigate('/signup');
      return;
    }

    setError('');
    setBusy(`${slug}:${provider}`);
    try {
      const { url } = await startCheckout(slug, provider);
      // Hand off to the gateway's hosted checkout — no card data touches us.
      window.location.href = url;
    } catch (err) {
      setError(errorMessage(err, 'Could not start checkout'));
      setBusy(null);
    }
  }

  if (error && !data) return <div className={s.page}><p className={s.error}>{error}</p></div>;
  if (!data) return <div className={s.page}><p className={s.loading}>Loading plans…</p></div>;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>Plans</h1>
        <p className={s.subtitle}>
          Every plan includes AI-written change reports. Upgrade or cancel whenever you like.
        </p>
      </header>

      {error && <p className={s.error}>{error}</p>}

      {data.providers.length === 0 && (
        <p className={s.notice}>
          Paid plans are not available on this deployment — no payment gateway is
          configured.
        </p>
      )}

      <div className={s.grid}>
        {data.plans.map((plan) => {
          const isCurrent = currentPlan?.slug === plan.slug;
          const isFree = plan.price_cents === 0;

          return (
            <section
              key={plan.slug}
              className={`${s.card} ${plan.slug === 'pro' ? s.featured : ''}`}
            >
              {plan.slug === 'pro' && <span className={s.ribbon}>Most popular</span>}

              <h2 className={s.planName}>{plan.name}</h2>
              <p className={s.price}>
                {/* The free tier is already named "Free"; repeating it as the
                    price reads like a mistake. Show the figure instead. */}
                {isFree ? '$0' : formatPrice(plan.price_cents, plan.currency)}
                <span className={s.interval}>/{plan.interval}</span>
              </p>

              <ul className={s.features}>
                {featureList(plan.entitlements).map((feature) => (
                  <li key={feature} className={s.feature}>{feature}</li>
                ))}
              </ul>

              <div className={s.actions}>
                {isCurrent ? (
                  <span className={s.current}>Your current plan</span>
                ) : isFree ? (
                  <Link to={isAuthenticated ? '/' : '/signup'} className={s.secondaryBtn}>
                    {isAuthenticated ? 'Included' : 'Get started free'}
                  </Link>
                ) : plan.purchasable_with.length === 0 ? (
                  <span className={s.unavailable}>Not available yet</span>
                ) : (
                  plan.purchasable_with.map((provider) => (
                    <button
                      key={provider}
                      className={provider === 'stripe' ? s.primaryBtn : s.secondaryBtn}
                      disabled={busy !== null}
                      onClick={() => handleSubscribe(plan.slug, provider)}
                    >
                      {busy === `${plan.slug}:${provider}`
                        ? 'Redirecting…'
                        : `Pay with ${PROVIDER_LABELS[provider] || provider}`}
                    </button>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      <p className={s.footnote}>
        Payments are processed by Stripe and PayPal. Card details never reach our servers.
      </p>
    </div>
  );
}
