import React, { useEffect, useState, useCallback, useMemo } from 'react';
import ScanResultCard from '../components/ScanResultCard';
import { getScans, exportScansPdf, downloadBlob, readBlobError } from '../api/client';
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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

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
          scan.domain,
          scan.srms_owner,
          scan.srms,
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
      } else if (sortBy === 'domain') {
        av = (a.domain || '').toLowerCase();
        bv = (b.domain || '').toLowerCase();
      } else if (sortBy === 'owner') {
        av = (a.srms_owner || '').toLowerCase();
        bv = (b.srms_owner || '').toLowerCase();
      } else if (sortBy === 'srms') {
        av = (a.srms || '').toLowerCase();
        bv = (b.srms || '').toLowerCase();
      } else if (sortBy === 'url') {
        av = (a.url || '').toLowerCase();
        bv = (b.url || '').toLowerCase();
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

  // Export every structured report currently in view (respects the search
  // filter) to a single PDF file.
  async function handleExportPdf() {
    setExportError('');
    setExporting(true);
    try {
      const ids = filteredSorted.map((scan) => scan.id).filter(Boolean);
      const res = await exportScansPdf(ids);
      downloadBlob(res, 'scan-reports.pdf');
    } catch (err) {
      // PDF export is a paid feature; a 402 already opens the shared upgrade
      // prompt, so adding an inline error on top would just be noise.
      if (err.response?.status !== 402) {
        const body = await readBlobError(err);
        setExportError(body.error || 'Failed to export reports to PDF');
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Scan History</h1>
        <div className={s.headerRight}>
          <span className={s.count}>
            {search ? `${filteredTotal} of ${total}` : total} scan(s)
          </span>
          <button
            className={s.exportBtn}
            onClick={handleExportPdf}
            disabled={exporting || filteredTotal === 0}
            title="Export all reports in view to a single PDF"
          >
            {exporting ? 'Exporting…' : '📄 Export reports (PDF)'}
          </button>
        </div>
      </div>

      {exportError && <p className={s.error}>{exportError}</p>}

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
            <option value="domain">Domain</option>
            <option value="owner">SRMS Owner</option>
            <option value="srms">SRMS</option>
            <option value="url">Internet hyperlinks</option>
          </select>
        </label>
        <label className={s.sortLabel}>
          Order
          <select
            className={s.select}
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value)}
          >
            <option value="asc">{sortBy === 'date' ? 'Oldest first' : 'A → Z'}</option>
            <option value="desc">{sortBy === 'date' ? 'Newest first' : 'Z → A'}</option>
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
