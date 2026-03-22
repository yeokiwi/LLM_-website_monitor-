import React from 'react';
import s from './WebsiteList.module.css';

export default function WebsiteList({
  websites,
  selected,
  onToggle,
  onSelectAll,
  onDelete,
}) {
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
            <th>Name</th>
            <th>URL</th>
            <th>Snapshots</th>
            <th>Last scanned</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {websites.map((w) => (
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
