/**
 * Scan allowance indicator for the app header.
 *
 * Scans are the metered resource that actually runs out mid-session, so it is
 * the one worth showing constantly — a customer should never be surprised by a
 * paywall they could have seen coming.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import s from './UsageMeter.module.css';

export default function UsageMeter() {
  const { usage, plan } = useAuth();

  if (!usage?.scans) return null;

  const { used, limit } = usage.scans;

  if (limit === null) {
    return (
      <Link to="/account/billing" className={s.unlimited} title="Unlimited scans">
        {plan?.name} · unlimited scans
      </Link>
    );
  }

  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const level = ratio >= 1 ? s.full : ratio >= 0.8 ? s.warn : s.ok;

  return (
    <Link
      to="/account/billing"
      className={s.meter}
      title={`${used} of ${limit} scans used this period (resets ${usage.window?.periodEnd})`}
    >
      <span className={s.label}>
        {used}/{limit} scans
      </span>
      <span className={s.track}>
        <span className={`${s.fill} ${level}`} style={{ width: `${ratio * 100}%` }} />
      </span>
    </Link>
  );
}
