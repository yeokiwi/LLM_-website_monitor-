/**
 * Spreadsheet export for the monitored websites.
 *
 * The exported columns round-trip with the importer above it on the dashboard,
 * so a list can be pulled out, edited in Excel and pushed back.
 */
import React, { useState } from 'react';
import { exportWebsites, downloadBlob, readBlobError } from '../api/client';
import s from './DataBackup.module.css';

export default function DataBackup() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleExportWebsites() {
    setError('');
    setBusy(true);
    try {
      const response = await exportWebsites();
      downloadBlob(response, 'websites.xlsx');
    } catch (err) {
      // Blob requests deliver their errors as a Blob, so unwrap it.
      const body = await readBlobError(err);
      setError(body.error || 'Failed to export websites');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.wrap}>
      <div className={s.row}>
        <button className={s.btn} onClick={handleExportWebsites} disabled={busy}>
          {busy ? 'Exporting…' : '📊 Export websites (.xlsx)'}
        </button>
      </div>
      <span className={s.hint}>
        The exported columns round-trip with the importer above.
      </span>

      {error && <p className={s.error}>{error}</p>}
    </div>
  );
}
