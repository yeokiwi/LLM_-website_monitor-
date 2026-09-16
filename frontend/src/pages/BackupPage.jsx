/**
 * Backup and restore.
 *
 * The endpoints behind this existed for a long time with nothing calling them,
 * which made the feature effectively absent. Restore is genuinely destructive —
 * it replaces every website, scan and schedule on the instance — so it lives on
 * its own page rather than next to the URL box on the dashboard, and it asks for
 * the confirmation to be typed. A `window.confirm` is one stray Enter away from
 * wiping the history.
 */
import React, { useRef, useState } from 'react';
import {
  exportDatabase,
  exportMyData,
  importDatabase,
  downloadBlob,
  readBlobError,
  errorMessage,
} from '../api/client';
import s from './BackupPage.module.css';

/** What the operator has to type before the restore button unlocks. */
const CONFIRM_PHRASE = 'replace all data';

export default function BackupPage() {
  const [busy, setBusy] = useState('');
  const [exportError, setExportError] = useState('');

  const [file, setFile] = useState(null);
  const [phrase, setPhrase] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  /** Both downloads behave identically; only the request differs. */
  async function download(kind, request, fallbackName) {
    setExportError('');
    setBusy(kind);
    try {
      downloadBlob(await request(), fallbackName);
    } catch (err) {
      // A blob request delivers its error as a Blob of JSON, not as an object.
      const body = await readBlobError(err);
      setExportError(body.error || 'Download failed');
    } finally {
      setBusy('');
    }
  }

  function handleFile(event) {
    const chosen = event.target.files?.[0];
    // Reset the input so picking the same file again still fires onChange.
    event.target.value = '';
    if (!chosen) return;

    setRestoreError('');
    setResult(null);
    setPhrase('');
    setFile(chosen);
  }

  async function handleRestore() {
    setRestoreError('');
    setRestoring(true);
    try {
      setResult(await importDatabase(file));
      setFile(null);
      setPhrase('');
    } catch (err) {
      setRestoreError(errorMessage(err, 'Restore failed'));
    } finally {
      setRestoring(false);
    }
  }

  const confirmed = phrase.trim().toLowerCase() === CONFIRM_PHRASE;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>Backup &amp; Restore</h1>
        <p className={s.subtitle}>
          Download everything this instance holds, or replace it with a backup
          taken earlier or from another instance.
        </p>
      </header>

      {/* ── Export ─────────────────────────────────────────────────────── */}
      <section className={s.card}>
        <h2 className={s.cardTitle}>Download a backup</h2>
        <p className={s.cardLead}>
          The full backup is a SQLite file holding every website, snapshot, scan
          and schedule. It carries no sign-in credentials — those live in the
          server&apos;s environment, not the database — so it is safe to store
          alongside your other backups and restores onto any instance.
        </p>

        <div className={s.row}>
          <button
            className={s.btn}
            type="button"
            disabled={Boolean(busy)}
            onClick={() => download('db', exportDatabase, 'monitor-backup.db')}
          >
            {busy === 'db' ? 'Preparing…' : '💾 Download full backup (.db)'}
          </button>

          <button
            className={s.btnSecondary}
            type="button"
            disabled={Boolean(busy)}
            onClick={() => download('json', exportMyData, 'my-monitor-data.json')}
          >
            {busy === 'json' ? 'Preparing…' : '📄 Download my data (.json)'}
          </button>
        </div>

        <p className={s.hint}>
          The JSON file is the readable one — websites and scan reports, openable
          in any text editor. It is not restorable; use the .db file for that.
        </p>

        {exportError && <p className={s.error}>{exportError}</p>}
      </section>

      {/* ── Restore ────────────────────────────────────────────────────── */}
      <section className={s.danger}>
        <h2 className={s.cardTitle}>Restore from a backup</h2>
        <p className={s.cardLead}>
          This <strong>replaces</strong> every website, snapshot, scan and
          schedule on this instance with the contents of the backup. Anything
          added since the backup was taken is lost. The current data is written
          to a <code>.bak-…</code> file next to the database first, but recovering
          from that means server access — it cannot be undone from here.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept=".db,.sqlite,.sqlite3"
          onChange={handleFile}
          style={{ display: 'none' }}
        />

        <div className={s.row}>
          <button
            className={s.btnSecondary}
            type="button"
            disabled={restoring}
            onClick={() => inputRef.current?.click()}
          >
            📁 Choose a backup file…
          </button>
        </div>

        {file && (
          <div className={s.confirmBox}>
            <p className={s.fileName}>
              Selected: <strong>{file.name}</strong>{' '}
              <span className={s.fileSize}>
                ({(file.size / 1024 / 1024).toFixed(1)} MB)
              </span>
            </p>

            <label className={s.confirmLabel} htmlFor="confirm-phrase">
              Type <code>{CONFIRM_PHRASE}</code> to enable the restore:
            </label>
            <input
              id="confirm-phrase"
              className={s.confirmInput}
              type="text"
              value={phrase}
              autoComplete="off"
              disabled={restoring}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={CONFIRM_PHRASE}
            />

            <div className={s.row}>
              <button
                className={s.btnDanger}
                type="button"
                disabled={!confirmed || restoring}
                onClick={handleRestore}
              >
                {restoring ? 'Restoring…' : 'Replace all data'}
              </button>
              <button
                className={s.btnSecondary}
                type="button"
                disabled={restoring}
                onClick={() => {
                  setFile(null);
                  setPhrase('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {restoreError && <p className={s.error}>{restoreError}</p>}

        {result && (
          <div className={s.success}>
            <p className={s.successTitle}>Database restored</p>
            <ul className={s.counts}>
              <li>{result.websites} website(s)</li>
              <li>{result.schedules} schedule(s)</li>
              <li>{result.scan_results} scan(s)</li>
              <li>{result.snapshots} snapshot(s)</li>
            </ul>
            <p className={s.hint}>
              The data replaced was saved as <code>{result.backup}</code> beside
              the database file.
            </p>
            {/* Every page holds state loaded from the old data, so reload rather
                than leaving half the app showing rows that no longer exist. */}
            <button
              className={s.btn}
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload the app
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
