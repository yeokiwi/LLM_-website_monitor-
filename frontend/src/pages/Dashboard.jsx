import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AddWebsiteForm from '../components/AddWebsiteForm';
import ExcelUpload from '../components/ExcelUpload';
import WebsiteList from '../components/WebsiteList';
import PeriodSelector from '../components/PeriodSelector';
import ScanResultCard from '../components/ScanResultCard';
import DataBackup from '../components/DataBackup';
import { getWebsites, deleteWebsite, bulkDeleteWebsites, updateWebsite, bulkUpdateWebsites } from '../api/client';
import { useScan } from '../context/ScanContext';
import { useAuth } from '../context/AuthContext';
import s from './Dashboard.module.css';

export default function Dashboard() {
  const [websites, setWebsites] = useState([]);
  const [selected, setSelected] = useState([]);
  const [period, setPeriod]     = useState(30);
  const [loadError, setLoadError] = useState('');

  // Scan state lives in ScanContext so it survives navigation away and back
  const { scanning, progress, scanResults, error: scanError, startScan } = useScan();

  // Every subscriber manages their own websites, so there is no admin gate
  // here any more — what varies by plan is the allowance and the extras.
  const { usage, plan, entitlements, refresh } = useAuth();

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

  async function handleToggleScraper(id, field, value) {
    const next = value ? 1 : 0;
    // Optimistic update; revert from server if the request fails.
    setWebsites((prev) => prev.map((w) => (w.id === id ? { ...w, [field]: next } : w)));
    try {
      await updateWebsite(id, { [field]: next });
    } catch {
      loadWebsites();
    }
  }

  async function handleToggleScraperAll(field, value) {
    const next = value ? 1 : 0;
    const ids = websites.map((w) => w.id);
    // Optimistic update for every row; revert from server on failure.
    setWebsites((prev) => prev.map((w) => ({ ...w, [field]: next })));
    try {
      await bulkUpdateWebsites(ids, { [field]: next });
    } catch {
      loadWebsites();
    }
  }

  async function handleSaveRemark(id, remark) {
    setWebsites((prev) => prev.map((w) => (w.id === id ? { ...w, remark } : w)));
    try {
      await updateWebsite(id, { remark });
    } catch {
      loadWebsites();
    }
  }

  async function handleDelete(id) {
    await deleteWebsite(id);
    setSelected((prev) => prev.filter((x) => x !== id));
    loadWebsites();
  }

  async function handleDeleteSelected() {
    if (selected.length === 0) return;
    const ok = window.confirm(
      `Remove ${selected.length} selected website(s)? This will also hide their scan history.`
    );
    if (!ok) return;
    try {
      await bulkDeleteWebsites(selected);
      setSelected([]);
      loadWebsites();
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Failed to remove selected websites');
    }
  }

  function handleScan() {
    // startScan is fire-and-forget from Dashboard's perspective; state
    // is managed in ScanContext and persists across navigation.
    // Refresh the account afterwards so the header's usage meter reflects the
    // scans that were just spent.
    startScan(selected, period, websites).then(() => {
      loadWebsites();
      refresh();
    });
  }

  const websiteLimit = usage?.websites?.limit ?? null;
  const atWebsiteLimit = websiteLimit !== null && websites.length >= websiteLimit;
  const scansLeft = usage?.scans?.remaining ?? null;
  const notEnoughScans = scansLeft !== null && selected.length > scansLeft;

  return (
    <div className={s.page}>
      {/* Add websites */}
      <section className={s.card}>
        <div className={s.listHeader}>
          <h2 className={s.sectionTitle}>Add Websites</h2>
          {websiteLimit !== null && (
            <span className={atWebsiteLimit ? s.quotaFull : s.quota}>
              {websites.length} of {websiteLimit} used
            </span>
          )}
        </div>

        {atWebsiteLimit ? (
          <p className={s.upsell}>
            You have used all {websiteLimit} website slots on the {plan?.name} plan.{' '}
            <Link to="/pricing" className={s.upsellLink}>Upgrade to add more</Link>, or
            remove a site below.
          </p>
        ) : (
          <>
            <div className={s.addRow}>
              <AddWebsiteForm onAdded={(w) => {
                setWebsites((prev) => [w, ...prev.filter((x) => x.id !== w.id)]);
                refresh();
              }} />
            </div>
            <div className={s.divider}>or</div>
          </>
        )}
        <ExcelUpload onImported={() => { loadWebsites(); refresh(); }} />
        <DataBackup />
      </section>

      {/* Website list + scan controls */}
      <section className={s.card}>
        <div className={s.listHeader}>
          <h2 className={s.sectionTitle}>Monitored Websites ({websites.length})</h2>
          <div className={s.controls}>
            <PeriodSelector value={period} onChange={setPeriod} />
            <button
              className={s.deleteSelectedBtn}
              onClick={handleDeleteSelected}
              disabled={scanning || selected.length === 0}
              title="Remove selected websites"
            >
              Delete Selected ({selected.length})
            </button>
            <button
              className={s.scanBtn}
              onClick={handleScan}
              disabled={scanning || selected.length === 0 || notEnoughScans}
              title={
                notEnoughScans
                  ? `Only ${scansLeft} scan${scansLeft === 1 ? '' : 's'} left this period`
                  : undefined
              }
            >
              {scanning ? 'Scanning…' : `Scan Selected (${selected.length})`}
            </button>
          </div>
        </div>

        {notEnoughScans && (
          <p className={s.upsell}>
            {scansLeft === 0
              ? `You have used all ${usage.scans.limit} scans included in the ${plan?.name} plan this period.`
              : `Only ${scansLeft} scan${scansLeft === 1 ? '' : 's'} remain this period — you have ${selected.length} selected.`}{' '}
            <Link to="/pricing" className={s.upsellLink}>See plans</Link>
          </p>
        )}

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
          canManage
          allowedEngines={entitlements.engines || ['direct']}
          onToggle={handleToggle}
          onSelectAll={setSelected}
          onDelete={handleDelete}
          onToggleScraper={handleToggleScraper}
          onToggleScraperAll={handleToggleScraperAll}
          onSaveRemark={handleSaveRemark}
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
