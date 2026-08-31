import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  getSubscription,
  openBillingPortal,
  cancelSubscription,
  activatePaypal,
  resendVerification,
  updatePreferences,
  changePassword,
  exportMyData,
  downloadBlob,
  readBlobError,
  errorMessage,
} from '../api/client';
import { useAuth } from '../context/AuthContext';
import s from './BillingPage.module.css';

function formatMoney(cents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
  }).format(Math.abs(cents) / 100);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A used/limit bar. `limit === null` means the plan has no cap. */
function Meter({ label, used, limit, note }) {
  const unlimited = limit === null;
  const ratio = unlimited || limit === 0 ? 0 : Math.min(1, used / limit);
  const level = ratio >= 1 ? s.full : ratio >= 0.8 ? s.warn : s.ok;

  return (
    <div className={s.meter}>
      <div className={s.meterHead}>
        <span className={s.meterLabel}>{label}</span>
        <span className={s.meterValue}>
          {used} {unlimited ? '' : `/ ${limit}`}
        </span>
      </div>
      <div className={s.meterTrack}>
        <div
          className={`${s.meterFill} ${unlimited ? s.ok : level}`}
          style={{ width: unlimited ? '100%' : `${ratio * 100}%` }}
        />
      </div>
      {note && <p className={s.meterNote}>{note}</p>}
    </div>
  );
}

export default function BillingPage() {
  const { user, refresh } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [params, setParams] = useSearchParams();

  const load = useCallback(async () => {
    try {
      setData(await getSubscription());
    } catch (err) {
      setError(errorMessage(err, 'Could not load your billing details'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // PayPal redirects back with the new subscription id. The webhook is
  // authoritative but can lag by seconds, so read it back here to show the new
  // plan immediately; both paths converge on the same server-side state.
  useEffect(() => {
    const paypalSubId = params.get('subscription_id');
    if (params.get('paypal') !== 'success' || !paypalSubId) return;

    activatePaypal(paypalSubId)
      .then(() => {
        setMessage('Your PayPal subscription is active. Thank you!');
        return Promise.all([load(), refresh()]);
      })
      .catch((err) => setError(errorMessage(err, 'Could not confirm your PayPal subscription')))
      .finally(() => {
        params.delete('paypal');
        params.delete('subscription_id');
        setParams(params, { replace: true });
      });
  }, [params, setParams, load, refresh]);

  // Stripe redirects back after hosted checkout; its webhook has usually landed
  // by the time the browser returns, so a refresh is enough.
  useEffect(() => {
    if (params.get('checkout') !== 'success') return;
    setMessage('Thank you — your subscription is being activated.');
    Promise.all([load(), refresh()]).finally(() => {
      params.delete('checkout');
      setParams(params, { replace: true });
    });
  }, [params, setParams, load, refresh]);

  async function run(key, action, successMessage) {
    setError('');
    setMessage('');
    setBusy(key);
    try {
      await action();
      if (successMessage) setMessage(successMessage);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }

  async function handlePortal() {
    await run('portal', async () => {
      const { url } = await openBillingPortal();
      window.location.href = url;
    });
  }

  async function handleCancel() {
    const confirmed = window.confirm(
      'Cancel your subscription? You keep your current plan until the end of the period you have paid for.'
    );
    if (!confirmed) return;

    await run(
      'cancel',
      async () => {
        await cancelSubscription();
        await Promise.all([load(), refresh()]);
      },
      'Your subscription has been cancelled.'
    );
  }

  async function handleExport() {
    await run('export', async () => {
      try {
        const response = await exportMyData();
        downloadBlob(response, 'my-monitor-data.json');
      } catch (err) {
        // A blob request returns its error as a Blob, so unwrap the real message.
        const body = await readBlobError(err);
        throw new Error(body.error || 'Export failed');
      }
    });
  }

  async function handlePreference(field, value) {
    await run(field, async () => {
      await updatePreferences({ [field]: value });
      await Promise.all([load(), refresh()]);
    });
  }

  if (!data) {
    return (
      <div className={s.page}>
        {error ? <p className={s.error}>{error}</p> : <p className={s.loading}>Loading…</p>}
      </div>
    );
  }

  const { plan, subscription, usage, payments } = data;
  const paid = plan.price_cents > 0;

  return (
    <div className={s.page}>
      <h1 className={s.title}>Account &amp; billing</h1>

      {message && <p className={s.success}>{message}</p>}
      {error && <p className={s.error}>{error}</p>}

      {/* ── Plan ─────────────────────────────────────────────────────────── */}
      <section className={s.card}>
        <div className={s.planHead}>
          <div>
            <p className={s.cardLabel}>Current plan</p>
            <h2 className={s.planName}>
              {plan.name}
              {subscription?.status && subscription.status !== 'active' && (
                <span className={s.status}>{subscription.status.replace('_', ' ')}</span>
              )}
            </h2>
          </div>
          <Link to="/pricing" className={s.linkBtn}>
            {paid ? 'Change plan' : 'Upgrade'}
          </Link>
        </div>

        {subscription?.in_grace_period && (
          <p className={s.warning}>
            We could not take your last payment. Your plan stays active for a short
            grace period — please update your payment details.
          </p>
        )}

        {subscription?.cancel_at_period_end && (
          <p className={s.warning}>
            Your subscription ends on {formatDate(subscription.current_period_end)}.
            You keep {plan.name} until then.
          </p>
        )}

        {paid && subscription && !subscription.cancel_at_period_end && (
          <p className={s.renewal}>
            Renews on {formatDate(subscription.current_period_end)} via{' '}
            {subscription.provider === 'paypal' ? 'PayPal' : 'card'}.
          </p>
        )}

        {paid && (
          <div className={s.rowActions}>
            {subscription?.provider === 'stripe' && (
              <button className={s.secondary} onClick={handlePortal} disabled={busy === 'portal'}>
                {busy === 'portal' ? 'Opening…' : 'Manage payment details'}
              </button>
            )}
            {!subscription?.cancel_at_period_end && (
              <button className={s.danger} onClick={handleCancel} disabled={busy === 'cancel'}>
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel subscription'}
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── Usage ────────────────────────────────────────────────────────── */}
      <section className={s.card}>
        <p className={s.cardLabel}>
          Usage this period
          {usage?.window && (
            <span className={s.period}>
              {' '}· resets {formatDate(usage.window.periodEnd)}
            </span>
          )}
        </p>

        <div className={s.meters}>
          <Meter label="Scans" used={usage.scans.used} limit={usage.scans.limit} />
          <Meter label="Monitored websites" used={usage.websites.used} limit={usage.websites.limit} />
        </div>

        <p className={s.detail}>
          {usage.llm_calls} AI {usage.llm_calls === 1 ? 'analysis' : 'analyses'} ·{' '}
          {usage.scrape_calls} source {usage.scrape_calls === 1 ? 'fetch' : 'fetches'}
        </p>
      </section>

      {/* ── Account ──────────────────────────────────────────────────────── */}
      <section className={s.card}>
        <p className={s.cardLabel}>Account</p>

        <dl className={s.details}>
          <div className={s.detailRow}>
            <dt>Email</dt>
            <dd>
              {user.email}
              {user.email_verified_at ? (
                <span className={s.verified}>verified</span>
              ) : (
                <button
                  className={s.inlineBtn}
                  disabled={busy === 'verify'}
                  onClick={() =>
                    run('verify', resendVerification, 'Verification email sent.')
                  }
                >
                  {busy === 'verify' ? 'Sending…' : 'Resend confirmation'}
                </button>
              )}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt>Member since</dt>
            <dd>{formatDate(user.created_at)}</dd>
          </div>
        </dl>

        <div className={s.prefs}>
          <label className={s.checkbox}>
            <input
              type="checkbox"
              checked={Boolean(user.notify_changes)}
              disabled={busy === 'notifyChanges'}
              onChange={(e) => handlePreference('notifyChanges', e.target.checked)}
            />
            Email me when a scheduled scan finds changes
          </label>
          <label className={s.checkbox}>
            <input
              type="checkbox"
              checked={Boolean(user.notify_billing)}
              disabled={busy === 'notifyBilling'}
              onChange={(e) => handlePreference('notifyBilling', e.target.checked)}
            />
            Email me receipts and billing notices
          </label>
        </div>

        <ChangePassword onDone={setMessage} onError={setError} />

        <button className={s.secondary} onClick={handleExport} disabled={busy === 'export'}>
          {busy === 'export' ? 'Preparing…' : 'Export my data'}
        </button>
      </section>

      {/* ── Invoices ─────────────────────────────────────────────────────── */}
      {payments.length > 0 && (
        <section className={s.card}>
          <p className={s.cardLabel}>Payments</p>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{formatDate(payment.paid_at)}</td>
                  <td>
                    {payment.amount_cents < 0 && '−'}
                    {formatMoney(payment.amount_cents, payment.currency)}
                  </td>
                  <td>
                    <span className={`${s.badge} ${s[payment.status] || ''}`}>
                      {payment.status}
                    </span>
                  </td>
                  <td>
                    {payment.invoice_url && (
                      <a
                        className={s.invoiceLink}
                        href={payment.invoice_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Invoice
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function ChangePassword({ onDone, onError }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    onError('');
    try {
      await changePassword(current, next);
      onDone('Password updated.');
      setOpen(false);
      setCurrent('');
      setNext('');
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button className={s.secondary} onClick={() => setOpen(true)}>
        Change password
      </button>
    );
  }

  return (
    <form className={s.passwordForm} onSubmit={handleSubmit}>
      <input
        className={s.input}
        type="password"
        placeholder="Current password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      <input
        className={s.input}
        type="password"
        placeholder="New password (10+ characters)"
        autoComplete="new-password"
        minLength={10}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        required
      />
      <div className={s.rowActions}>
        <button className={s.primary} type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className={s.secondary} type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
