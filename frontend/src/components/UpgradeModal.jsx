/**
 * The single paywall prompt.
 *
 * Any 402 from any endpoint publishes through `onPaywall`, so a blocked action
 * explains itself in one place instead of each caller inventing an error
 * message. Mounted once, near the router root.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onPaywall } from '../api/client';
import s from './UpgradeModal.module.css';

/** Turn the API's structured 402 into a heading and a body. */
function describe(detail) {
  if (detail.quota === 'scans') {
    return {
      title: 'Scan limit reached',
      body:
        detail.remaining === 0
          ? `You have used all ${detail.limit} scans included in your plan. The allowance resets on ${detail.periodEnd}.`
          : `This would use ${detail.requested} scans but only ${detail.remaining} remain this period.`,
    };
  }

  if (detail.quota === 'websites') {
    return {
      title: 'Website limit reached',
      body: `Your plan covers ${detail.limit} monitored website${
        detail.limit === 1 ? '' : 's'
      } and you are using ${detail.used}.`,
    };
  }

  return {
    title: 'Not included in your plan',
    body: detail.error || 'This feature requires a different plan.',
  };
}

export default function UpgradeModal() {
  const [detail, setDetail] = useState(null);
  const navigate = useNavigate();

  useEffect(() => onPaywall(setDetail), []);

  // Escape closes, matching every other dialog the user has ever used.
  useEffect(() => {
    if (!detail) return undefined;
    const onKey = (e) => e.key === 'Escape' && setDetail(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  if (!detail) return null;

  const { title, body } = describe(detail);
  const upgradeTo = detail.upgradeTo;

  return (
    <div className={s.backdrop} onClick={() => setDetail(null)} role="presentation">
      <div
        className={s.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={s.icon}>⚡</div>
        <h2 className={s.title} id="upgrade-title">{title}</h2>
        <p className={s.body}>{body}</p>

        {upgradeTo && (
          <p className={s.hint}>
            The <strong>{upgradeTo.name}</strong> plan{' '}
            {detail.quota ? 'lifts this limit' : 'includes this'}.
          </p>
        )}

        <div className={s.actions}>
          <button className={s.secondary} onClick={() => setDetail(null)}>
            Not now
          </button>
          <button
            className={s.primary}
            onClick={() => {
              setDetail(null);
              navigate('/pricing');
            }}
          >
            {upgradeTo ? `See the ${upgradeTo.name} plan` : 'See plans'}
          </button>
        </div>
      </div>
    </div>
  );
}
