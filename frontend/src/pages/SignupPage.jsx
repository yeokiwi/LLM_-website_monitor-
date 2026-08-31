import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import s from './LoginPage.module.css';

const MIN_PASSWORD_LENGTH = 10;

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { signup } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Mirror the server's policy so the user finds out before a round trip.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    setLoading(true);
    try {
      await signup(email, password, name);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account. Please try again.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={s.page}>
      <div className={s.card}>
        <div className={s.logo}>🔍</div>
        <h1 className={s.title}>Create your account</h1>
        <p className={s.subtitle}>Start monitoring on the free plan — no card needed</p>

        <form className={s.form} onSubmit={handleSubmit}>
          <div className={s.field}>
            <label className={s.label} htmlFor="name">Name <span className={s.optional}>(optional)</span></label>
            <input
              id="name"
              className={s.input}
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="email">Email</label>
            <input
              id="email"
              className={s.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="password">Password</label>
            <input
              id="password"
              className={s.input}
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className={s.help}>At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>

          {error && <p className={s.error}>{error}</p>}

          <button className={s.btn} type="submit" disabled={loading}>
            {loading ? 'Creating your account…' : 'Create account'}
          </button>
        </form>

        <p className={s.meta}>
          Already have an account? <Link to="/login" className={s.link}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
