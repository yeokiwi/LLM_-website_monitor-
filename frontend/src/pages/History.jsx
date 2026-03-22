import React, { useEffect, useState, useCallback } from 'react';
import ScanResultCard from '../components/ScanResultCard';
import { getScans } from '../api/client';
import s from './History.module.css';

const PAGE_SIZE = 10;

export default function History() {
  const [scans, setScans] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (off) => {
    setLoading(true);
    setError('');
    try {
      const data = await getScans(PAGE_SIZE, off);
      setScans(data.results);
      setTotal(data.total);
    } catch {
      setError('Failed to load scan history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(offset);
  }, [load, offset]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Scan History</h1>
        <span className={s.count}>{total} scan(s) total</span>
      </div>

      {error && <p className={s.error}>{error}</p>}

      {loading ? (
        <div className={s.loading}>Loading…</div>
      ) : scans.length === 0 ? (
        <div className={s.empty}>No scans yet. Go to the Dashboard to run your first scan.</div>
      ) : (
        <>
          <div className={s.list}>
            {scans.map((scan) => (
              <ScanResultCard key={scan.id} result={scan} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className={s.pagination}>
              <button
                className={s.pageBtn}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={currentPage === 1}
              >
                ← Prev
              </button>
              <span className={s.pageInfo}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                className={s.pageBtn}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={currentPage === totalPages}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
