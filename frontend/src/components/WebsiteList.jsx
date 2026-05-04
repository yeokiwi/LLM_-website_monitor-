import React, { useState, useMemo } from 'react';
import s from './WebsiteList.module.css';

const SORT_KEYS = {
  name: (w) => (w.name || '').toLowerCase(),
  url: (w) => (w.url || '').toLowerCase(),
  snapshot_count: (w) => w.snapshot_count ?? 0,
  last_scanned_at: (w) => (w.last_scanned_at ? new Date(w.last_scanned_at).getTime() : 0),
};

export default function WebsiteList({
  websites,
  selected,
  onToggle,
  onSelectAll,
  onDelete,
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
            <th className={s.sortable} onClick={() => handleSort('url')}>
              URL {sortIndicator('url')}
            </th>
            <th className={s.sortable} onClick={() => handleSort('snapshot_count')}>
              Snapshots {sortIndicator('snapshot_count')}
            </th>
            <th className={s.sortable} onClick={() => handleSort('last_scanned_at')}>
              Last scanned {sortIndicator('last_scanned_at')}
            </th>
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
              <td className={s.url}>
                <a href={w.url} target="_blank" rel="noopener noreferrer">
                  {w.url}
                </a>
              </td>
              <td className={s.center}>{w.snapshot_count ?? 0}</td>
              <td className={s.date}>
                {w.last_scanned_at
                  ? new Date(w.last_scanned_at).toLocaleString()
                  : <span className={s.never}>Never</span>}
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
