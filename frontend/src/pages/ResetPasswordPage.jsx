import React, { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { resetPassword, errorMessage } from '../api/client';
import s from './LoginPage.module.css';

const MIN_PASSWORD_LENGTH = 10;

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 2000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className={s.page}>
        <div className={s.card}>
          <div className={s.logo}>🔑</div>
          <h1 className={s.title}>Reset link incomplete</h1>
          <p className={s.subtitle}>This link is missing its token</p>
          <p className={s.meta}>
            <Link to="/forgot-password" className={s.link}>Request a new link</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.card}>
        <div className={s.logo}>🔑</div>
        <h1 className={s.title}>Choose a new password</h1>

        {done ? (
          <>
            <p className={s.notice}>Password updated. Taking you to sign in…</p>
            <p className={s.meta}>
              <Link to="/login" className={s.link}>Sign in now</Link>
            </p>
          </>
        ) : (
          <form className={s.form} onSubmit={handleSubmit}>
            <div className={s.field}>
              <label className={s.label} htmlFor="password">New password</label>
              <input
                id="password"
                className={s.input}
                type="password"
                autoComplete="new-password"
                autoFocus
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <p className={s.help}>At least {MIN_PASSWORD_LENGTH} characters.</p>
            </div>

            <div className={s.field}>
              <label className={s.label} htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                className={s.input}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>

            {error && <p className={s.error}>{error}</p>}

            <button className={s.btn} type="submit" disabled={loading}>
              {loading ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
