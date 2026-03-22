import React, { useState } from 'react';
import { addWebsite } from '../api/client';
import s from './AddWebsiteForm.module.css';

export default function AddWebsiteForm({ onAdded }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!url.trim()) return;

    setLoading(true);
    try {
      const website = await addWebsite(url.trim(), name.trim());
      onAdded(website);
      setUrl('');
      setName('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add website');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className={s.form} onSubmit={handleSubmit}>
      <div className={s.fields}>
        <input
          className={s.input}
          type="url"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <input
          className={s.input}
          type="text"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className={s.btn} type="submit" disabled={loading}>
          {loading ? 'Adding…' : 'Add Website'}
        </button>
      </div>
      {error && <p className={s.error}>{error}</p>}
    </form>
  );
}
