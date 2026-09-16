/**
 * Tenant-facing data export.
 *
 * The old whole-database backup and restore is gone from here: on a
 * multi-tenant platform that file holds every customer's data, so it is now a
 * platform-operator action. What a subscriber gets instead is their own data —
 * a spreadsheet that round-trips with the importer, and a full JSON export on
 * the billing page.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
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
