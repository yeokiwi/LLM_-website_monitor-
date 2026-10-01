/**
 * Website groups.
 *
 * A group is a named, saved set of websites with the people to tell about it.
 * It is scanned by hand ("Scan now" selects it on the dashboard) or on a
 * schedule (set on the Schedules page), and a scheduled run emails one digest
 * to the group's recipients.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  getGroups,
  getWebsites,
  getNotificationSettings,
  createGroup,
  updateGroup,
  deleteGroup,
  errorMessage,
} from '../api/client';
import s from './GroupsPage.module.css';

const FREQUENCY_LABELS = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };
const NOTIFY_LABELS = {
  changes: 'Only when something changed or failed',
  always: 'After every scheduled run',
};

/** How many member names a collapsed card shows before "+N more". */
const PREVIEW_MEMBERS = 6;

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function lastResult(schedule) {
  if (!schedule?.last_status) return 'not run yet';
  if (schedule.last_status === 'empty') return 'no active websites';
  const parts = [];
  if (schedule.last_changed) parts.push(`${schedule.last_changed} changed`);
  if (schedule.last_failed) parts.push(`${schedule.last_failed} failed`);
  return parts.length ? parts.join(' · ') : 'no changes';
}

// ---------------------------------------------------------------------------

export default function GroupsPage() {
  const [groups, setGroups] = useState([]);
  const [websites, setWebsites] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null); // a group id, or 'new'
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const [groupData, siteData, settingsData] = await Promise.all([
        getGroups(),
        getWebsites(),
        getNotificationSettings(),
      ]);
      setGroups(groupData.groups);
      setWebsites(siteData);
      setSettings(settingsData);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Failed to load groups'));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const siteById = useMemo(() => new Map(websites.map((w) => [w.id, w])), [websites]);

  async function handleCreate(fields) {
    await createGroup(fields);
    setEditingId(null);
    await load();
  }

  async function handleUpdate(id, fields) {
    await updateGroup(id, fields);
    setEditingId(null);
    await load();
  }

  async function handleDelete(group) {
    const ok = window.confirm(
      `Delete the group “${group.name}”?\n\n` +
        'Its schedule stops. The websites and their scan history are not touched.'
    );
    if (!ok) return;
    try {
      await deleteGroup(group.id);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to delete the group'));
    }
  }

  if (!loaded) return <div className={s.page}><p className={s.muted}>Loading…</p></div>;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1 className={s.title}>Website groups</h1>
          <p className={s.subtitle}>
            Save a set of websites under a name, then scan it in one go — by hand
            from the dashboard, or on a schedule that emails the people who look
            after those sites.
          </p>
        </div>
        {editingId !== 'new' && (
          <button
            type="button"
            className={s.btn}
            onClick={() => setEditingId('new')}
            disabled={websites.length === 0}
          >
            + New group
          </button>
        )}
      </header>

      {error && <p className={s.error}>{error}</p>}

      {editingId === 'new' && (
        <GroupEditor
          title="New group"
          initial={{ name: '', website_ids: [], notify_emails: [], notify_on: 'changes' }}
          websites={websites}
          onSave={handleCreate}
          onCancel={() => setEditingId(null)}
        />
      )}

      {groups.length === 0 && editingId !== 'new' && (
        <div className={s.empty}>
          <p><strong>No groups yet.</strong></p>
          <p>
            Tick some websites on the <Link to="/" className={s.link}>Dashboard</Link> and
            choose <em>Save selection as group</em>, or use <em>New group</em> above.
          </p>
        </div>
      )}

      {groups.map((group) =>
        editingId === group.id ? (
          <GroupEditor
            key={group.id}
            title={`Edit “${group.name}”`}
            initial={group}
            websites={websites}
            onSave={(fields) => handleUpdate(group.id, fields)}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <GroupCard
            key={group.id}
            group={group}
            siteById={siteById}
            settings={settings}
            onEdit={() => setEditingId(group.id)}
            onScan={() => navigate('/', { state: { groupId: group.id } })}
            onDelete={() => handleDelete(group)}
          />
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function GroupCard({ group, siteById, settings, onEdit, onScan, onDelete }) {
  const [expanded, setExpanded] = useState(false);

  const members = group.website_ids.map((id) => siteById.get(id)).filter(Boolean);
  const shown = expanded ? members : members.slice(0, PREVIEW_MEMBERS);
  const hidden = members.length - shown.length;

  // Where this group's emails would actually go — the same resolution the
  // scheduler uses, so the card never promises a recipient that will not get it.
  let recipients;
  if (group.notify_emails.length > 0) {
    recipients = <span>{group.notify_emails.join(', ')}</span>;
  } else if (settings?.defaultEmails.length > 0) {
    recipients = (
      <span>
        the default list <span className={s.muted}>({settings.defaultEmails.join(', ')})</span>
      </span>
    );
  } else if (settings?.accountEmailUsable) {
    recipients = <span>{settings.accountEmail} <span className={s.muted}>(the account address)</span></span>;
  } else {
    recipients = (
      <span className={s.warn}>
        nobody yet — add recipients here or a default list on{' '}
        <Link to="/schedules" className={s.link}>Schedules</Link>
      </span>
    );
  }

  const schedule = group.schedule;

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h2 className={s.cardTitle}>{group.name}</h2>
          <p className={s.muted}>
            {group.member_count} website{group.member_count === 1 ? '' : 's'}
          </p>
        </div>
        <div className={s.actions}>
          <button
            type="button"
            className={s.btnPrimary}
            onClick={onScan}
            disabled={group.member_count === 0}
            title="Select this group's websites on the dashboard"
          >
            Scan now
          </button>
          <button type="button" className={s.btnSecondary} onClick={onEdit}>Edit</button>
          <button type="button" className={s.btnDanger} onClick={onDelete}>Delete</button>
        </div>
      </div>

      {members.length > 0 ? (
        <ul className={s.members}>
          {shown.map((w) => (
            <li key={w.id} className={s.member} title={w.url}>{w.name || w.url}</li>
          ))}
          {hidden > 0 && (
            <li>
              <button type="button" className={s.more} onClick={() => setExpanded(true)}>
                +{hidden} more
              </button>
            </li>
          )}
        </ul>
      ) : (
        <p className={s.warn}>This group has no websites. Edit it to add some.</p>
      )}

      <dl className={s.facts}>
        <dt>Schedule</dt>
        <dd>
          {schedule && schedule.is_enabled ? (
            <>
              {FREQUENCY_LABELS[schedule.frequency] || schedule.frequency}, last{' '}
              {schedule.period_days} days · next {formatDate(schedule.next_run_at)} · last
              result: {lastResult(schedule)}
            </>
          ) : (
            <span className={s.muted}>Manual only — </span>
          )}{' '}
          <Link to="/schedules" className={s.link}>
            {schedule && schedule.is_enabled ? 'change' : 'add a schedule'}
          </Link>
        </dd>

        <dt>Emails go to</dt>
        <dd>{recipients}</dd>

        <dt>Email when</dt>
        <dd>{NOTIFY_LABELS[group.notify_on]}</dd>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------

function GroupEditor({ title, initial, websites, onSave, onCancel }) {
  const [name, setName] = useState(initial.name);
  const [memberIds, setMemberIds] = useState(() => new Set(initial.website_ids));
  const [emails, setEmails] = useState(initial.notify_emails.join('\n'));
  const [notifyOn, setNotifyOn] = useState(initial.notify_on);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? websites.filter((w) =>
        [w.name, w.url, w.domain, w.srms_owner, w.srms]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle))
      )
    : websites;

  function toggle(id) {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setVisible(on) {
    setMemberIds((prev) => {
      const next = new Set(prev);
      for (const w of visible) {
        if (on) next.add(w.id);
        else next.delete(w.id);
      }
      return next;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSave({
        name,
        websiteIds: [...memberIds],
        notifyEmails: emails,
        notifyOn,
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the group'));
      setSaving(false);
    }
  }

  return (
    <form className={s.editor} onSubmit={handleSubmit}>
      <h2 className={s.cardTitle}>{title}</h2>

      <label className={s.field}>
        <span className={s.fieldLabel}>Name</span>
        <input
          className={s.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="e.g. SRMS statutes"
          required
          autoFocus
        />
      </label>

      <div className={s.field}>
        <span className={s.fieldLabel}>
          Websites <span className={s.muted}>({memberIds.size} selected)</span>
        </span>
        <div className={s.pickerTools}>
          <input
            className={s.input}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, URL, domain, owner…"
          />
          <button type="button" className={s.btnSecondary} onClick={() => setVisible(true)}>
            Select {needle ? 'shown' : 'all'}
          </button>
          <button type="button" className={s.btnSecondary} onClick={() => setVisible(false)}>
            Clear {needle ? 'shown' : 'all'}
          </button>
        </div>
        <div className={s.checklist}>
          {visible.length === 0 && <p className={s.muted}>No websites match.</p>}
          {visible.map((w) => (
            <label key={w.id} className={s.checkRow}>
              <input
                type="checkbox"
                checked={memberIds.has(w.id)}
                onChange={() => toggle(w.id)}
              />
              <span className={s.checkName}>{w.name || w.url}</span>
              {w.name && <span className={s.checkUrl}>{w.url}</span>}
            </label>
          ))}
        </div>
      </div>

      <label className={s.field}>
        <span className={s.fieldLabel}>Email scheduled results to</span>
        <textarea
          className={s.textarea}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          rows={3}
          placeholder={'legal-team@example.com\nops@example.com'}
        />
        <span className={s.hint}>
          One address per line, or separated by commas. Leave empty to use the
          default list from the Schedules page.
        </span>
      </label>

      <fieldset className={s.field}>
        <legend className={s.fieldLabel}>Send an email</legend>
        {Object.entries(NOTIFY_LABELS).map(([value, label]) => (
          <label key={value} className={s.radio}>
            <input
              type="radio"
              name="notify-on"
              value={value}
              checked={notifyOn === value}
              onChange={() => setNotifyOn(value)}
            />
            {label}
          </label>
        ))}
        <span className={s.hint}>
          Applies to scheduled runs only — a scan you start yourself shows its
          results on screen instead.
        </span>
      </fieldset>

      {error && <p className={s.error}>{error}</p>}

      <div className={s.actions}>
        <button type="submit" className={s.btnPrimary} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save group'}
        </button>
        <button type="button" className={s.btnSecondary} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
