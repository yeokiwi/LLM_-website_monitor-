import React, { useCallback, useEffect, useState } from 'react';
import AddWebsiteForm from '../components/AddWebsiteForm';
import ExcelUpload from '../components/ExcelUpload';
import WebsiteList from '../components/WebsiteList';
import PeriodSelector from '../components/PeriodSelector';
import ScanResultCard from '../components/ScanResultCard';
import { getWebsites, deleteWebsite } from '../api/client';
import { useScan } from '../context/ScanContext';
import s from './Dashboard.module.css';

export default function Dashboard() {
  const [websites, setWebsites] = useState([]);
  const [selected, setSelected] = useState([]);
  const [period, setPeriod]     = useState(30);
  const [loadError, setLoadError] = useState('');

  // Scan state lives in ScanContext so it survives navigation away and back
  const { scanning, progress, scanResults, error: scanError, startScan } = useScan();

  const loadWebsites = useCallback(async () => {
    try {
      const data = await getWebsites();
      setWebsites(data);
    } catch {
      setLoadError('Failed to load websites');
    }
  }, []);

  // Re-fetch the list on mount (picks up fresh snapshot counts after returning
  // from another page mid-scan or after a scan that finished while away)
  useEffect(() => {
    loadWebsites();
  }, [loadWebsites]);

  function handleToggle(id) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleDelete(id) {
    await deleteWebsite(id);
    setSelected((prev) => prev.filter((x) => x !== id));
    loadWebsites();
  }

  function handleScan() {
    // startScan is fire-and-forget from Dashboard's perspective; state
    // is managed in ScanContext and persists across navigation.
    startScan(selected, period, websites).then(loadWebsites);
  }

  return (
    <div className={s.page}>
      {/* Add websites section */}
      <section className={s.card}>
        <h2 className={s.sectionTitle}>Add Websites</h2>
        <div className={s.addRow}>
          <AddWebsiteForm onAdded={(w) => { setWebsites((prev) => [w, ...prev.filter((x) => x.id !== w.id)]); }} />
        </div>
        <div className={s.divider}>or</div>
        <ExcelUpload onImported={loadWebsites} />
      </section>

      {/* Website list + scan controls */}
      <section className={s.card}>
        <div className={s.listHeader}>
          <h2 className={s.sectionTitle}>Monitored Websites ({websites.length})</h2>
          <div className={s.controls}>
            <PeriodSelector value={period} onChange={setPeriod} />
            <button
              className={s.scanBtn}
              onClick={handleScan}
              disabled={scanning || selected.length === 0}
            >
              {scanning ? 'Scanning…' : `Scan Selected (${selected.length})`}
            </button>
          </div>
        </div>

        {/* Per-site progress bar */}
        {progress && (
          <div className={s.progressWrap}>
            <div className={s.progressBar}>
              <div
                className={s.progressFill}
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
            <p className={s.progressLabel}>
              Scanning <strong>{progress.siteName}</strong>
              &nbsp;({progress.current} of {progress.total})
            </p>
          </div>
        )}

        {(loadError || scanError) && (
          <p className={s.error}>{loadError || scanError}</p>
        )}

        <WebsiteList
          websites={websites}
          selected={selected}
          onToggle={handleToggle}
          onSelectAll={setSelected}
          onDelete={handleDelete}
        />
      </section>

      {/* Scan results — accumulate in real-time as each site completes */}
      {scanResults.length > 0 && (
        <section className={s.card}>
          <h2 className={s.sectionTitle}>Scan Results</h2>
          <div className={s.results}>
            {scanResults.map((r) => (
              <ScanResultCard key={r.scanId} result={r} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
