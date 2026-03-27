/**
 * ScanContext
 *
 * Holds all scanning state above the router so that navigating between
 * Dashboard, Scan History, and other pages never interrupts or loses
 * an in-progress batch scan.
 */
import React, { createContext, useContext, useState, useCallback } from 'react';
import { triggerScan } from '../api/client';

const ScanContext = createContext(null);

export function ScanProvider({ children }) {
  const [scanning, setScanning]     = useState(false);
  const [progress, setProgress]     = useState(null); // { current, total, siteName }
  const [scanResults, setScanResults] = useState([]);
  const [error, setError]           = useState('');

  /**
   * Run a batch scan for the given site IDs one at a time.
   * Fires one POST /api/scans request per site so the frontend can
   * track per-site progress without any backend changes.
   *
   * @param {number[]} selectedIds
   * @param {number}   period       — monitoring period in days
   * @param {object[]} websites     — full website list (for name lookup)
   */
  const startScan = useCallback(async (selectedIds, period, websites) => {
    if (selectedIds.length === 0) return;

    setScanning(true);
    setScanResults([]);
    setError('');

    const total  = selectedIds.length;
    const errors = [];

    for (let i = 0; i < total; i++) {
      const id   = selectedIds[i];
      const site = websites.find((w) => w.id === id);

      setProgress({
        current:  i + 1,
        total,
        siteName: site?.name || site?.url || String(id),
      });

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
  }, []);

  return (
    <ScanContext.Provider value={{ scanning, progress, scanResults, error, startScan }}>
      {children}
    </ScanContext.Provider>
  );
}

export function useScan() {
  return useContext(ScanContext);
}
