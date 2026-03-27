import React, { useCallback, useEffect, useState } from 'react';
import AddWebsiteForm from '../components/AddWebsiteForm';
import ExcelUpload from '../components/ExcelUpload';
import WebsiteList from '../components/WebsiteList';
import PeriodSelector from '../components/PeriodSelector';
import ScanResultCard from '../components/ScanResultCard';
import { getWebsites, deleteWebsite, triggerScan } from '../api/client';
import s from './Dashboard.module.css';

export default function Dashboard() {
  const [websites, setWebsites] = useState([]);
  const [selected, setSelected] = useState([]);
  const [period, setPeriod] = useState(30);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [error, setError] = useState('');
  // { current: number, total: number, siteName: string } | null
  const [progress, setProgress] = useState(null);

  const loadWebsites = useCallback(async () => {
    try {
      const data = await getWebsites();
      setWebsites(data);
    } catch {
      setError('Failed to load websites');
    }
  }, []);

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

  async function handleScan() {
    if (selected.length === 0) return;
    setScanning(true);
    setScanResults([]);
    setError('');

    const total = selected.length;
    const errors = [];

    for (let i = 0; i < total; i++) {
      const id = selected[i];
      const site = websites.find((w) => w.id === id);
      setProgress({ current: i + 1, total, siteName: site?.name || site?.url || String(id) });

      try {
        const data = await triggerScan([id], period);
        setScanResults((prev) => [...prev, ...(data.results || [])]);
      } catch (err) {
        errors.push(`${site?.url || id}: ${err.response?.data?.error || err.message}`);
      }
    }

    setProgress(null);
    setScanning(false);
    if (errors.length) setError(errors.join('\n'));
    loadWebsites();
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

        {error && <p className={s.error}>{error}</p>}

        <WebsiteList
          websites={websites}
          selected={selected}
          onToggle={handleToggle}
          onSelectAll={setSelected}
          onDelete={handleDelete}
        />
      </section>

      {/* Scan results */}
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
