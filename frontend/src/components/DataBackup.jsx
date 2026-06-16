import React, { useRef, useState } from 'react';
import { exportDatabase, exportWebsites, importDatabase, downloadBlob } from '../api/client';
import s from './DataBackup.module.css';

export default function DataBackup({ onImported }) {
  const inputRef = useRef();
  const [busy, setBusy] = useState('');       // which action is running
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function handleExportDatabase() {
    setError('');
    setSuccess('');
    setBusy('db');
    try {
      const res = await exportDatabase();
      downloadBlob(res, 'monitor-backup.db');
    } catch {
      setError('Failed to export database');
    } finally {
      setBusy('');
    }
  }

  async function handleExportWebsites() {
    setError('');
    setSuccess('');
    setBusy('xlsx');
    try {
      const res = await exportWebsites();
      downloadBlob(res, 'websites.xlsx');
    } catch {
      setError('Failed to export websites');
    } finally {
      setBusy('');
    }
  }

  async function handleImportFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    setSuccess('');

    const ok = window.confirm(
      'Restoring a backup REPLACES ALL current data (websites, snapshots and ' +
        'scan history) with the contents of this file. Your current data is ' +
        'saved to a .bak file first. Continue?'
    );
    if (!ok) return;

    setBusy('import');
    try {
      const result = await importDatabase(file);
      setSuccess(
        `Database restored: ${result.websites} website(s), ` +
          `${result.snapshots} snapshot(s), ${result.scan_results} scan(s). ` +
          `Previous data saved to ${result.backup}.`
      );
      onImported?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={s.wrap}>
      <div className={s.row}>
        <button className={s.btn} onClick={handleExportDatabase} disabled={!!busy}>
          {busy === 'db' ? 'Exporting…' : '💾 Export database (.db)'}
        </button>
        <button className={s.btn} onClick={handleExportWebsites} disabled={!!busy}>
          {busy === 'xlsx' ? 'Exporting…' : '📊 Export websites (.xlsx)'}
        </button>
        <button
          className={s.btn}
          onClick={() => inputRef.current.click()}
          disabled={!!busy}
        >
          {busy === 'import' ? 'Restoring…' : '♻️ Import database (.db)'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".db,.sqlite,.sqlite3"
          onChange={handleImportFile}
          style={{ display: 'none' }}
        />
      </div>
      <span className={s.hint}>
        Full backup includes websites, snapshots and scan history. Importing a
        backup <strong>replaces all current data</strong>.
      </span>

      {error && <p className={s.error}>{error}</p>}
      {success && <p className={s.success}>{success}</p>}
    </div>
  );
}
