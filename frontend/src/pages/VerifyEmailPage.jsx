import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { verifyEmail, errorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import s from './LoginPage.module.css';

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');

  const [state, setState] = useState(token ? 'verifying' : 'missing');
  const [error, setError] = useState('');

  const { refresh, isAuthenticated } = useAuth();

  // Guards against React 18 StrictMode's double-invoked effects, which would
  // otherwise consume the single-use token twice and show a spurious failure.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    verifyEmail(token)
      .then(() => {
        setState('done');
        if (isAuthenticated) refresh();
      })
      .catch((err) => {
        setError(errorMessage(err, 'This verification link is not valid'));
        setState('failed');
      });
  }, [token, refresh, isAuthenticated]);

  return (
    <div className={s.page}>
      <div className={s.card}>
        <div className={s.logo}>{state === 'done' ? '✅' : '✉️'}</div>

        {state === 'verifying' && (
          <>
            <h1 className={s.title}>Confirming your email</h1>
            <p className={s.status}>One moment…</p>
          </>
        )}

        {state === 'done' && (
          <>
            <h1 className={s.title}>Email confirmed</h1>
            <p className={s.notice}>Your email address is verified.</p>
            <p className={s.meta}>
              <Link to="/" className={s.link}>Go to your dashboard</Link>
            </p>
          </>
        )}

        {state === 'failed' && (
          <>
            <h1 className={s.title}>Could not confirm</h1>
            <p className={s.error}>{error}</p>
            <p className={s.meta}>
              Signed in? You can request a fresh link from{' '}
              <Link to="/account/billing" className={s.link}>your account</Link>.
            </p>
          </>
        )}

        {state === 'missing' && (
          <>
            <h1 className={s.title}>Link incomplete</h1>
            <p className={s.subtitle}>This confirmation link is missing its token</p>
            <p className={s.meta}>
              <Link to="/" className={s.link}>Back to the app</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
