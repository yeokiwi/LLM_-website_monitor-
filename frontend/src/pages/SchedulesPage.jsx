import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getSchedules,
  getWebsites,
  setSchedule,
  removeSchedule,
  getGroups,
  setGroupSchedule,
  removeGroupSchedule,
  getNotificationSettings,
  saveNotificationSettings,
  sendTestEmail,
  errorMessage,
} from '../api/client';
import s from './SchedulesPage.module.css';

const FREQUENCY_LABELS = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };
const ALL_FREQUENCIES = ['hourly', 'daily', 'weekly'];

/** Monitoring periods offered for a group schedule, in days. */
const PERIODS = [7, 14, 30, 60, 90];

function formatNext(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** A group run's outcome, as "3 changed · 1 failed". */
function groupResult(schedule) {
  if (!schedule?.last_status) return null;
  if (schedule.last_status === 'empty') return 'no active websites';
  const parts = [];
  if (schedule.last_changed) parts.push(`${schedule.last_changed} changed`);
  if (schedule.last_failed) parts.push(`${schedule.last_failed} failed`);
  return parts.length ? parts.join(' · ') : 'no changes';
}

export default function SchedulesPage() {
  const [websites, setWebsites] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [groups, setGroups] = useState([]);
  const [allowed, setAllowed] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [siteList, scheduleData, groupData] = await Promise.all([
        getWebsites(),
        getSchedules(),
        getGroups(),
      ]);
      setWebsites(siteList);
      setSchedules(scheduleData.schedules);
      setAllowed(scheduleData.allowedFrequencies);
      setGroups(groupData.groups);
    } catch (err) {
      setError(errorMessage(err, 'Could not load your schedules'));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const scheduleFor = (websiteId) => schedules.find((x) => x.website_id === websiteId);

  // Which scheduled groups each website belongs to — so a site that is also
  // scheduled on its own is visible as double-covered, not found on the bill.
  const scheduledGroupsBySite = useMemo(() => {
    const map = new Map();
    for (const group of groups) {
      if (!group.schedule?.is_enabled) continue;
      for (const id of group.website_ids) {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(group.name);
      }
    }
    return map;
  }, [groups]);

  async function run(key, action, fallback) {
    setError('');
    setBusyId(key);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorMessage(err, fallback));
    } finally {
      setBusyId(null);
    }
  }

  function handleWebsiteChange(website, frequency) {
    return run(
      `site-${website.id}`,
      () => (frequency === 'off'
        ? removeSchedule(website.id)
        : setSchedule(website.id, { frequency, periodDays: 30, isEnabled: true })),
      'Could not update the schedule'
    );
  }

  function handleGroupChange(group, { frequency, periodDays }) {
    return run(
      `group-${group.id}`,
      () => (frequency === 'off'
        ? removeGroupSchedule(group.id)
        : setGroupSchedule(group.id, { frequency, periodDays, isEnabled: true })),
      'Could not update the group schedule'
    );
  }

  if (!loaded) {
    return <div className={s.page}><p className={s.loading}>Loading…</p></div>;
  }

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1 className={s.title}>Automatic scans</h1>
          <p className={s.subtitle}>
            Check whole groups or single websites on a schedule, and email the
            people who need to know when a run finishes.
          </p>
        </div>
      </header>

      {error && <p className={s.error}>{error}</p>}

      <NotificationsCard />

      {/* ── Groups ─────────────────────────────────────────────────────── */}
      <h2 className={s.sectionTitle}>Groups</h2>
      {groups.length === 0 ? (
        <p className={s.empty}>
          No groups yet. <Link to="/groups" className={s.link}>Create one</Link> to scan a
          set of websites together and email one digest per run.
        </p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Group</th>
              <th>Frequency</th>
              <th>Period</th>
              <th>Next run</th>
              <th>Last result</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const schedule = group.schedule;
              const current = schedule?.is_enabled ? schedule.frequency : 'off';
              const period = schedule?.period_days || 30;
              const busy = busyId === `group-${group.id}`;
              const periods = PERIODS.includes(period) ? PERIODS : [...PERIODS, period].sort((a, b) => a - b);

              return (
                <tr key={group.id}>
                  <td>
                    <Link to="/groups" className={s.siteName}>{group.name}</Link>
                    <span className={s.siteUrl}>
                      {group.member_count} website{group.member_count === 1 ? '' : 's'}
                    </span>
                  </td>
                  <td>
                    <select
                      className={s.select}
                      value={current}
                      disabled={busy || group.member_count === 0}
                      onChange={(e) => handleGroupChange(group, { frequency: e.target.value, periodDays: period })}
                      aria-label={`Frequency for ${group.name}`}
                    >
                      <option value="off">Manual only</option>
                      {ALL_FREQUENCIES.map((frequency) => (
                        <option key={frequency} value={frequency} disabled={!allowed.includes(frequency)}>
                          {FREQUENCY_LABELS[frequency]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className={s.select}
                      value={period}
                      disabled={busy || current === 'off'}
                      onChange={(e) => handleGroupChange(group, { frequency: current, periodDays: Number(e.target.value) })}
                      aria-label={`Monitoring period for ${group.name}`}
                      title="How far back each scheduled scan looks for changes"
                    >
                      {periods.map((days) => (
                        <option key={days} value={days}>Last {days} days</option>
                      ))}
                    </select>
                  </td>
                  <td className={s.muted}>
                    {current === 'off' ? '—' : formatNext(schedule?.next_run_at)}
                  </td>
                  <td className={s.muted}>
                    {groupResult(schedule) ? (
                      <span className={schedule.last_failed ? s.badgeWarn : s.badge}>
                        {groupResult(schedule)}
                      </span>
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

      {/* ── Single websites ───────────────────────────────────────────── */}
      <h2 className={s.sectionTitle}>Single websites</h2>
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
              const viaGroups = scheduledGroupsBySite.get(website.id) || [];

              return (
                <tr key={website.id}>
                  <td>
                    <span className={s.siteName}>{website.name || website.url}</span>
                    <span className={s.siteUrl}>{website.url}</span>
                    {viaGroups.length > 0 && (
                      <span className={current === 'off' ? s.viaGroup : s.overlap}>
                        {current === 'off'
                          ? `Scanned via ${viaGroups.join(', ')}`
                          : `Also scheduled via ${viaGroups.join(', ')} — scanned by both`}
                      </span>
                    )}
                  </td>
                  <td>
                    <select
                      className={s.select}
                      value={current}
                      disabled={busyId === `site-${website.id}`}
                      onChange={(e) => handleWebsiteChange(website, e.target.value)}
                      aria-label={`Frequency for ${website.name || website.url}`}
                    >
                      <option value="off">Manual only</option>
                      {ALL_FREQUENCIES.map((frequency) => (
                        <option
                          key={frequency}
                          value={frequency}
                          // `allowed` is whatever the API reports it supports.
                          // That is every cadence now, but reading it from the
                          // response keeps the two in step if it ever narrows.
                          disabled={!allowed.includes(frequency)}
                        >
                          {FREQUENCY_LABELS[frequency]}
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

// ---------------------------------------------------------------------------
// Default recipients, mail status and a test send
// ---------------------------------------------------------------------------

function NotificationsCard() {
  const [settings, setSettings] = useState(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testResults, setTestResults] = useState(null);

  useEffect(() => {
    getNotificationSettings()
      .then((data) => {
        setSettings(data);
        setText(data.defaultEmails.join('\n'));
      })
      .catch((err) => setError(errorMessage(err, 'Could not load notification settings')));
  }, []);

  const dirty = settings && text.trim() !== settings.defaultEmails.join('\n');

  async function handleSave() {
    setError('');
    setNotice('');
    setTestResults(null);
    setSaving(true);
    try {
      const data = await saveNotificationSettings(text);
      setSettings(data);
      setText(data.defaultEmails.join('\n'));
      setNotice(data.defaultEmails.length ? 'Default recipients saved.' : 'Default recipients cleared.');
    } catch (err) {
      setError(errorMessage(err, 'Could not save the recipients'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setError('');
    setNotice('');
    setTestResults(null);
    setTesting(true);
    try {
      setTestResults(await sendTestEmail());
    } catch (err) {
      setError(errorMessage(err, 'The test email could not be sent'));
    } finally {
      setTesting(false);
    }
  }

  if (!settings) {
    return error ? <p className={s.error}>{error}</p> : null;
  }

  return (
    <section className={s.card}>
      <h2 className={s.cardTitle}>Email notifications</h2>

      {!settings.smtpConfigured && (
        <p className={s.warning}>
          <strong>Email is not set up on the server.</strong> Scheduled scans still
          run, but notifications are written to the server log instead of being
          sent. Set <code>SMTP_HOST</code> (and the other <code>SMTP_*</code>{' '}
          variables) to deliver them.
        </p>
      )}

      <p className={s.cardLead}>
        Groups email their own recipients. These default recipients cover groups
        without a list of their own, and single-website schedules.
        {!settings.accountEmailUsable && (
          <> With no default set, nothing is sent — the sign-in account
          ({settings.accountEmail}) is not a real address.</>
        )}
      </p>

      <label className={s.fieldLabel} htmlFor="default-recipients">Default recipients</label>
      <textarea
        id="default-recipients"
        className={s.textarea}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'monitoring@example.com\nlegal-team@example.com'}
        disabled={saving}
      />

      <div className={s.cardActions}>
        <button
          type="button"
          className={s.btnPrimary}
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save recipients'}
        </button>
        <button
          type="button"
          className={s.btnSecondary}
          onClick={handleTest}
          disabled={testing || dirty || settings.defaultEmails.length === 0 || !settings.smtpConfigured}
          title={
            !settings.smtpConfigured
              ? 'Email is not set up on the server'
              : dirty
                ? 'Save the recipients first'
                : 'Send a test message to the default recipients'
          }
        >
          {testing ? 'Sending…' : 'Send test email'}
        </button>
      </div>

      {error && <p className={s.error}>{error}</p>}
      {notice && <p className={s.notice}>{notice}</p>}
      {testResults && (
        <ul className={s.testResults}>
          {testResults.results.map((r) => (
            <li key={r.to} className={r.sent ? s.sentOk : s.sentFail}>
              {r.sent ? '✓ Accepted for delivery:' : '✗ Rejected:'} {r.to}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
