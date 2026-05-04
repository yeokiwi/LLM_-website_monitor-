import React, { useEffect, useState, useCallback, useMemo } from 'react';
import ScanResultCard from '../components/ScanResultCard';
import { getScans } from '../api/client';
import s from './History.module.css';

const PAGE_SIZE = 10;
// Pull a generous batch from the server so client-side search/sort sees
// the full picture rather than only the visible page.
const FETCH_LIMIT = 500;

export default function History() {
  const [scans, setScans] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getScans(FETCH_LIMIT, 0);
      setScans(data.results);
      setTotal(data.total);
    } catch {
      setError('Failed to load scan history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Reset to page 1 whenever the filter or sort changes
  useEffect(() => {
    setOffset(0);
  }, [search, sortBy, sortDir]);

  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    let list = scans;
    if (term) {
      list = list.filter((scan) => {
        const haystack = [
          scan.name,
          scan.url,
          scan.llm_summary,
          scan.diff_summary,
          scan.status,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(term);
      });
    }

    const sorted = [...list];
    sorted.sort((a, b) => {
      let av, bv;
      if (sortBy === 'name') {
        av = (a.name || a.url || '').toLowerCase();
        bv = (b.name || b.url || '').toLowerCase();
      } else {
        av = a.scanned_at ? new Date(a.scanned_at).getTime() : 0;
        bv = b.scanned_at ? new Date(b.scanned_at).getTime() : 0;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [scans, search, sortBy, sortDir]);

  const filteredTotal = filteredSorted.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const pageItems = filteredSorted.slice(offset, offset + PAGE_SIZE);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Scan History</h1>
        <span className={s.count}>
          {search ? `${filteredTotal} of ${total}` : total} scan(s)
        </span>
      </div>

      <div className={s.controls}>
        <input
          type="text"
          className={s.search}
          placeholder="Search by name, URL or summary…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className={s.sortLabel}>
          Sort by
          <select
            className={s.select}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="date">Date</option>
            <option value="name">Name</option>
          </select>
        </label>
        <label className={s.sortLabel}>
          Order
          <select
            className={s.select}
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value)}
          >
            <option value="asc">{sortBy === 'name' ? 'A → Z' : 'Oldest first'}</option>
            <option value="desc">{sortBy === 'name' ? 'Z → A' : 'Newest first'}</option>
          </select>
        </label>
      </div>

      {error && <p className={s.error}>{error}</p>}

      {loading ? (
        <div className={s.loading}>Loading…</div>
      ) : scans.length === 0 ? (
        <div className={s.empty}>No scans yet. Go to the Dashboard to run your first scan.</div>
      ) : pageItems.length === 0 ? (
        <div className={s.empty}>No scans match your search.</div>
      ) : (
        <>
          <div className={s.list}>
            {pageItems.map((scan) => (
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
