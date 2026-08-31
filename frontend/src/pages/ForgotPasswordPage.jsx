import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword, errorMessage } from '../api/client';
import s from './LoginPage.module.css';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await forgotPassword(email);
      // The API answers identically whether or not the address is registered,
      // and so does this page — it must not become an account oracle.
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={s.page}>
      <div className={s.card}>
        <div className={s.logo}>🔑</div>
        <h1 className={s.title}>Reset your password</h1>

        {sent ? (
          <>
            <p className={s.subtitle}>Check your inbox</p>
            <p className={s.notice}>
              If that email has an account, a reset link is on its way. The link
              expires in one hour.
            </p>
            <p className={s.meta}>
              <Link to="/login" className={s.link}>Back to sign in</Link>
            </p>
          </>
        ) : (
          <>
            <p className={s.subtitle}>We will email you a link to choose a new one</p>

            <form className={s.form} onSubmit={handleSubmit}>
              <div className={s.field}>
                <label className={s.label} htmlFor="email">Email</label>
                <input
                  id="email"
                  className={s.input}
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              {error && <p className={s.error}>{error}</p>}

              <button className={s.btn} type="submit" disabled={loading}>
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>

            <p className={s.meta}>
              <Link to="/login" className={s.link}>Back to sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
