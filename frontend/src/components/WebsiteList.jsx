import React, { useState, useMemo, useEffect } from 'react';
import s from './WebsiteList.module.css';

/** Inline-editable remark cell — saves on blur (or Enter) when changed. */
function RemarkCell({ website, onSaveRemark }) {
  const [value, setValue] = useState(website.remark || '');
  const [saving, setSaving] = useState(false);

  // Sync if the row's remark changes from outside (e.g. after a reload)
  useEffect(() => {
    setValue(website.remark || '');
  }, [website.remark]);

  async function commit() {
    if (value === (website.remark || '')) return;
    setSaving(true);
    try {
      await onSaveRemark?.(website.id, value);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="text"
      className={s.remarkInput}
      value={value}
      placeholder="Add remark…"
      disabled={saving}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

const SORT_KEYS = {
  name: (w) => (w.name || '').toLowerCase(),
  domain: (w) => (w.domain || '').toLowerCase(),
  srms_owner: (w) => (w.srms_owner || '').toLowerCase(),
  srms: (w) => (w.srms || '').toLowerCase(),
  internet_hyperlinks: (w) => (w.url || '').toLowerCase(),
  snapshot_count: (w) => w.snapshot_count ?? 0,
  last_scanned_at: (w) => (w.last_scanned_at ? new Date(w.last_scanned_at).getTime() : 0),
};

export default function WebsiteList({
  websites,
  selected,
  onToggle,
  onSelectAll,
  onDelete,
  onToggleScraper,
  onSaveRemark,
}) {
  const [sortBy, setSortBy] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const sorted = useMemo(() => {
    if (!sortBy || !SORT_KEYS[sortBy]) return websites;
    const keyFn = SORT_KEYS[sortBy];
    const copy = [...websites];
    copy.sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [websites, sortBy, sortDir]);

  function handleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  }

  function sortIndicator(key) {
    if (sortBy !== key) return <span className={s.sortIcon}>⇅</span>;
    return <span className={s.sortIconActive}>{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  if (websites.length === 0) {
    return (
      <div className={s.empty}>
        No websites added yet. Add one above or import from Excel.
      </div>
    );
  }

  const allSelected = websites.every((w) => selected.includes(w.id));

  return (
    <div className={s.wrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th className={s.checkCol}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => onSelectAll(allSelected ? [] : websites.map((w) => w.id))}
              />
            </th>
            <th className={s.sortable} onClick={() => handleSort('name')}>
              Name {sortIndicator('name')}
            </th>
            <th className={s.sortable} onClick={() => handleSort('domain')}>
              Domain {sortIndicator('domain')}
            </th>
            <th className={s.sortable} onClick={() => handleSort('srms_owner')}>
              SRMS Owner {sortIndicator('srms_owner')}
            </th>
            <th className={s.sortable} onClick={() => handleSort('srms')}>
              SRMS {sortIndicator('srms')}
            </th>
            <th className={s.sortable} onClick={() => handleSort('internet_hyperlinks')}>
              Internet hyperlinks {sortIndicator('internet_hyperlinks')}
            </th>
            <th className={s.scraperHead}>Scrape with</th>
            <th className={s.sortable} onClick={() => handleSort('snapshot_count')}>
              Snapshots {sortIndicator('snapshot_count')}
            </th>
            <th className={s.sortable} onClick={() => handleSort('last_scanned_at')}>
              Last scanned {sortIndicator('last_scanned_at')}
            </th>
            <th className={s.remarkHead}>Remark</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((w) => (
            <tr key={w.id} className={selected.includes(w.id) ? s.rowSelected : ''}>
              <td className={s.checkCol}>
                <input
                  type="checkbox"
                  checked={selected.includes(w.id)}
                  onChange={() => onToggle(w.id)}
                />
              </td>
              <td className={s.name}>{w.name || <span className={s.unnamed}>—</span>}</td>
              <td className={s.meta}>{w.domain || <span className={s.unnamed}>—</span>}</td>
              <td className={s.meta}>{w.srms_owner || <span className={s.unnamed}>—</span>}</td>
              <td className={s.metaWide} title={w.srms || ''}>
                {w.srms || <span className={s.unnamed}>—</span>}
              </td>
              <td className={s.url}>
                <a href={w.url} target="_blank" rel="noopener noreferrer">
                  {w.url}
                </a>
              </td>
              <td className={s.scraperCell}>
                <label className={s.scraperOption}>
                  <input
                    type="checkbox"
                    checked={!!w.use_firecrawl}
                    onChange={(e) => onToggleScraper?.(w.id, 'use_firecrawl', e.target.checked)}
                  />
                  Firecrawl
                </label>
                <label className={s.scraperOption}>
                  <input
                    type="checkbox"
                    checked={!!w.use_brave}
                    onChange={(e) => onToggleScraper?.(w.id, 'use_brave', e.target.checked)}
                  />
                  Brave
                </label>
              </td>
              <td className={s.center}>{w.snapshot_count ?? 0}</td>
              <td className={s.date}>
                {w.last_scanned_at
                  ? new Date(w.last_scanned_at).toLocaleString()
                  : <span className={s.never}>Never</span>}
              </td>
              <td className={s.remarkCell}>
                <RemarkCell website={w} onSaveRemark={onSaveRemark} />
              </td>
              <td className={s.actions}>
                <button
                  className={s.deleteBtn}
                  onClick={() => onDelete(w.id)}
                  title="Remove"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
