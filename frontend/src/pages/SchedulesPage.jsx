import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getSchedules,
  getWebsites,
  setSchedule,
  removeSchedule,
  errorMessage,
} from '../api/client';
import { useAuth } from '../context/AuthContext';
import s from './SchedulesPage.module.css';

const FREQUENCY_LABELS = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };
const ALL_FREQUENCIES = ['hourly', 'daily', 'weekly'];

function formatNext(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function SchedulesPage() {
  const [websites, setWebsites] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [allowed, setAllowed] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const { plan } = useAuth();

  const load = useCallback(async () => {
    try {
      const [siteList, scheduleData] = await Promise.all([getWebsites(), getSchedules()]);
      setWebsites(siteList);
      setSchedules(scheduleData.schedules);
      setAllowed(scheduleData.allowedFrequencies);
    } catch (err) {
      setError(errorMessage(err, 'Could not load your schedules'));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const scheduleFor = (websiteId) => schedules.find((x) => x.website_id === websiteId);

  async function handleChange(website, frequency) {
    setError('');
    setBusyId(website.id);
    try {
      if (frequency === 'off') {
        await removeSchedule(website.id);
      } else {
        await setSchedule(website.id, { frequency, periodDays: 30, isEnabled: true });
      }
      await load();
    } catch (err) {
      // A 402 already surfaces through the shared upgrade modal; anything else
      // is worth showing inline.
      if (err.response?.status !== 402) {
        setError(errorMessage(err, 'Could not update the schedule'));
      }
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded) {
    return <div className={s.page}><p className={s.loading}>Loading…</p></div>;
  }

  const schedulingLocked = allowed.length === 0;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1 className={s.title}>Automatic scans</h1>
          <p className={s.subtitle}>
            Let Website Monitor check your sites on a schedule and email you when
            something changes.
          </p>
        </div>
      </header>

      {error && <p className={s.error}>{error}</p>}

      {schedulingLocked && (
        <div className={s.locked}>
          <p className={s.lockedTitle}>Scheduled scans are not part of the {plan?.name} plan</p>
          <p className={s.lockedBody}>
            Upgrade to have your sites checked automatically, with an email when
            something changes.
          </p>
          <Link to="/pricing" className={s.upgradeBtn}>See plans</Link>
        </div>
      )}

      {websites.length === 0 ? (
        <p className={s.empty}>
          You have no websites yet. <Link to="/" className={s.link}>Add one first.</Link>
        </p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Website</th>
              <th>Frequency</th>
              <th>Next run</th>
              <th>Last result</th>
            </tr>
          </thead>
          <tbody>
            {websites.map((website) => {
              const schedule = scheduleFor(website.id);
              const current = schedule?.is_enabled ? schedule.frequency : 'off';

              return (
                <tr key={website.id}>
                  <td>
                    <span className={s.siteName}>{website.name || website.url}</span>
                    <span className={s.siteUrl}>{website.url}</span>
                  </td>
                  <td>
                    <select
                      className={s.select}
                      value={current}
                      disabled={busyId === website.id || schedulingLocked}
                      onChange={(e) => handleChange(website, e.target.value)}
                    >
                      <option value="off">Manual only</option>
                      {ALL_FREQUENCIES.map((frequency) => (
                        <option
                          key={frequency}
                          value={frequency}
                          disabled={!allowed.includes(frequency)}
                        >
                          {FREQUENCY_LABELS[frequency]}
                          {allowed.includes(frequency) ? '' : ' (upgrade)'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={s.muted}>
                    {current === 'off' ? '—' : formatNext(schedule?.next_run_at)}
                  </td>
                  <td className={s.muted}>
                    {schedule?.last_status ? (
                      <span className={s.badge}>{schedule.last_status.replace(/_/g, ' ')}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
