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
import { useAuth } from '../context/AuthContext';
import s from './DataBackup.module.css';

export default function DataBackup() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { can } = useAuth();
  const unlocked = can('excel_import_export');

  async function handleExportWebsites() {
    setError('');
    setBusy(true);
    try {
      const response = await exportWebsites();
      downloadBlob(response, 'websites.xlsx');
    } catch (err) {
      // Blob requests deliver their errors as a Blob, so unwrap it. A 402 has
      // already opened the shared upgrade prompt; nothing to add inline.
      const body = await readBlobError(err);
      if (err.response?.status !== 402) {
        setError(body.error || 'Failed to export websites');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <div className={s.wrap}>
        <span className={s.hint}>
          Spreadsheet import and export are part of the Business plan.{' '}
          <Link to="/pricing" className={s.link}>See plans</Link>
        </span>
      </div>
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.row}>
        <button className={s.btn} onClick={handleExportWebsites} disabled={busy}>
          {busy ? 'Exporting…' : '📊 Export websites (.xlsx)'}
        </button>
      </div>
      <span className={s.hint}>
        The exported columns round-trip with the importer above. For your full
        scan history, use <Link to="/account/billing" className={s.link}>Export my data</Link>.
      </span>

      {error && <p className={s.error}>{error}</p>}
    </div>
  );
}
