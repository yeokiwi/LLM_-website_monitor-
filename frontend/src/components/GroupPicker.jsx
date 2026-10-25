/**
 * Saved website groups, on the dashboard.
 *
 * Picking a group replaces the selection with its websites, so the ordinary
 * "Scan Selected" runs it — with the same per-site progress and results as any
 * other scan. Saving goes the other way: the current selection becomes a group.
 * Editing a group's members, recipients and schedule lives on the Groups page.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createGroup, errorMessage } from '../api/client';
import s from './GroupPicker.module.css';

/** Same websites, regardless of order. */
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export default function GroupPicker({ groups, selected, disabled, onSelect, onSaved }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Tell the user when what they have ticked is exactly a saved group.
  const matching = selected.length > 0
    ? groups.find((g) => g.website_ids.length > 0 && sameSet(g.website_ids, selected))
    : null;

  function handlePick(event) {
    const group = groups.find((g) => String(g.id) === event.target.value);
    if (!group) return;
    setError('');
    setNotice('');
    onSelect(group.website_ids);
  }

  async function handleSave(event) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const group = await createGroup({ name, websiteIds: selected });
      setNotice(`Saved “${group.name}” with ${group.member_count} website(s).`);
      setNaming(false);
      setName('');
      onSaved(group);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the group'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={s.bar}>
      <div className={s.row}>
        <label className={s.label} htmlFor="group-picker">Group</label>
        <select
          id="group-picker"
          className={s.select}
          value=""
          onChange={handlePick}
          disabled={disabled || groups.length === 0}
        >
          <option value="">
            {groups.length === 0 ? 'No saved groups yet' : 'Select a group…'}
          </option>
          {groups.map((g) => (
            <option key={g.id} value={g.id} disabled={g.member_count === 0}>
              {g.name} ({g.member_count})
            </option>
          ))}
        </select>

        {matching && (
          <span className={s.match}>
            Selected: <strong>{matching.name}</strong>
          </span>
        )}

        {!naming && selected.length > 0 && !matching && (
          <button
            type="button"
            className={s.saveBtn}
            onClick={() => {
              setNaming(true);
              setNotice('');
            }}
            disabled={disabled}
          >
            Save selection as group
          </button>
        )}

        <Link to="/groups" className={s.manage}>Manage groups</Link>
      </div>

      {naming && (
        <form className={s.row} onSubmit={handleSave}>
          <input
            className={s.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`Name for these ${selected.length} website(s)`}
            maxLength={100}
            autoFocus
            disabled={saving}
          />
          <button type="submit" className={s.saveBtn} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save group'}
          </button>
          <button
            type="button"
            className={s.cancelBtn}
            onClick={() => {
              setNaming(false);
              setName('');
              setError('');
            }}
            disabled={saving}
          >
            Cancel
          </button>
        </form>
      )}

      {error && <p className={s.error}>{error}</p>}
      {notice && (
        <p className={s.notice}>
          {notice} <Link to="/groups" className={s.manage}>Add recipients or a schedule</Link>
        </p>
      )}
    </div>
  );
}
