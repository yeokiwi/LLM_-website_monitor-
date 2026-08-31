/**
 * Platform operator dashboard.
 *
 * The only screen in the app that shows data across tenants — reachable solely
 * by the superadmin account.
 */
import React, { useEffect, useState } from 'react';
import { getAdminStats, getAdminUsers, getAdminSubscriptions, errorMessage } from '../api/client';
import s from './AdminPage.module.css';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value || 0);
}

function Stat({ label, value }) {
  return (
    <div className={s.stat}>
      <span className={s.statValue}>{value}</span>
      <span className={s.statLabel}>{label}</span>
    </div>
  );
}

export default function AdminPage() {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getAdminStats(), getAdminUsers(), getAdminSubscriptions()])
      .then(([statsData, userData, subData]) => {
        setStats(statsData);
        setUsers(userData.users);
        setSubscriptions(subData.subscriptions);
      })
      .catch((err) => setError(errorMessage(err, 'Could not load platform data')));
  }, []);

  if (error) return <div className={s.page}><p className={s.error}>{error}</p></div>;
  if (!stats) return <div className={s.page}><p className={s.loading}>Loading…</p></div>;

  const revenue = stats.revenue_this_period;

  return (
    <div className={s.page}>
      <h1 className={s.title}>Platform</h1>
      <p className={s.subtitle}>
        Usage window {stats.window.periodStart} → {stats.window.periodEnd}
      </p>

      <section className={s.stats}>
        <Stat label="Accounts" value={formatNumber(stats.counts.users)} />
        <Stat label="Subscriptions" value={formatNumber(stats.counts.live_subscriptions)} />
        <Stat label="Active websites" value={formatNumber(stats.counts.active_websites)} />
        <Stat label="Active schedules" value={formatNumber(stats.counts.active_schedules)} />
        <Stat label="Scans (all time)" value={formatNumber(stats.counts.scans_all_time)} />
        <Stat label="Scans this period" value={formatNumber(stats.usage.scans_used)} />
      </section>

      <section className={s.card}>
        <h2 className={s.cardTitle}>Cost this period</h2>
        <p className={s.costLine}>
          {formatNumber(stats.usage.llm_calls)} AI calls ·{' '}
          {formatNumber(stats.usage.input_tokens)} input tokens ·{' '}
          {formatNumber(stats.usage.output_tokens)} output tokens ·{' '}
          {formatNumber(stats.usage.scrape_calls)} source fetches
        </p>
        <p className={s.revenue}>
          Revenue:{' '}
          {revenue.length === 0
            ? 'none recorded'
            : revenue
                .map((r) =>
                  new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: r.currency.toUpperCase(),
                  }).format(r.cents / 100)
                )
                .join(' · ')}
        </p>
      </section>

      <section className={s.card}>
        <h2 className={s.cardTitle}>Subscribers by plan</h2>
        <table className={s.table}>
          <thead>
            <tr><th>Plan</th><th>Price</th><th>Subscribers</th><th>Gateway ids</th></tr>
          </thead>
          <tbody>
            {stats.subscribers_by_plan.map((row) => {
              const planConfig = stats.plans.find((p) => p.slug === row.slug);
              return (
                <tr key={row.slug}>
                  <td>{row.name}</td>
                  <td>
                    {planConfig?.price_cents
                      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
                          .format(planConfig.price_cents / 100)
                      : 'Free'}
                  </td>
                  <td>{formatNumber(row.subscribers)}</td>
                  <td className={s.muted}>
                    {planConfig?.price_cents === 0
                      ? '—'
                      : [
                          planConfig?.stripe_price_id ? 'Stripe ✓' : 'Stripe ✗',
                          planConfig?.paypal_plan_id ? 'PayPal ✓' : 'PayPal ✗',
                        ].join(' · ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className={s.card}>
        <h2 className={s.cardTitle}>Accounts</h2>
        <table className={s.table}>
          <thead>
            <tr><th>Email</th><th>Role</th><th>Websites</th><th>Joined</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  {user.email}
                  {!user.email_verified_at && <span className={s.pill}>unverified</span>}
                  {user.status !== 'active' && <span className={s.pillWarn}>{user.status}</span>}
                </td>
                <td className={s.muted}>{user.role}</td>
                <td className={s.muted}>{formatNumber(user.website_count)}</td>
                <td className={s.muted}>{formatDate(user.created_at)}</td>
                <td className={s.muted}>{formatDate(user.last_login_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {subscriptions.length > 0 && (
        <section className={s.card}>
          <h2 className={s.cardTitle}>Subscriptions</h2>
          <table className={s.table}>
            <thead>
              <tr><th>Account</th><th>Plan</th><th>Status</th><th>Gateway</th><th>Renews</th></tr>
            </thead>
            <tbody>
              {subscriptions.map((sub) => (
                <tr key={sub.id}>
                  <td>{sub.email}</td>
                  <td className={s.muted}>{sub.plan_name}</td>
                  <td><span className={s.pill}>{sub.status.replace('_', ' ')}</span></td>
                  <td className={s.muted}>{sub.provider || '—'}</td>
                  <td className={s.muted}>{formatDate(sub.current_period_end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
