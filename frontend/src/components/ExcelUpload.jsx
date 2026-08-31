import React, { useRef, useState } from 'react';
import { uploadExcel, bulkAddWebsites } from '../api/client';
import s from './ExcelUpload.module.css';

export default function ExcelUpload({ onImported }) {
  const inputRef = useRef();
  const [preview, setPreview] = useState(null); // { count, websites }
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setError('');
    setSuccess('');
    setPreview(null);
    setLoading(true);

    try {
      const data = await uploadExcel(file);
      setPreview(data);
    } catch (err) {
      // A 402 already opens the shared upgrade prompt; repeating it inline
      // would say the same thing twice.
      if (err.response?.status !== 402) {
        setError(err.response?.data?.error || 'Failed to parse file');
      }
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  }

  async function handleImport() {
    if (!preview) return;
    setImporting(true);
    setError('');

    try {
      const result = await bulkAddWebsites(preview.websites);
      setSuccess(`Imported ${result.added} website(s)${result.skipped > 0 ? `, skipped ${result.skipped}` : ''}.`);
      setPreview(null);
      onImported();
    } catch (err) {
      // The batch can exceed the plan's website allowance; that 402 opens the
      // shared upgrade prompt rather than an inline error.
      if (err.response?.status !== 402) {
        setError(err.response?.data?.error || 'Import failed');
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className={s.wrap}>
      <button className={s.uploadBtn} onClick={() => inputRef.current.click()} disabled={loading}>
        {loading ? 'Parsing…' : '📂 Import from Excel / CSV'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={handleFile}
        style={{ display: 'none' }}
      />
      <span className={s.hint}>
        Expected columns: <strong>URL</strong> or <strong>Internet hyperlinks</strong> (required);
        optional: <strong>Name</strong>, <strong>Domain</strong>, <strong>SRMS Owner</strong>, <strong>SRMS</strong>
      </span>

      {error && <p className={s.error}>{error}</p>}
      {success && <p className={s.success}>{success}</p>}

      {preview && (
        <div className={s.preview}>
          <p className={s.previewTitle}>
            Found <strong>{preview.count}</strong> valid website(s) in the file
            {preview.sheets > 1 && ` across ${preview.sheets} sheets`}
            {preview.skipped > 0 && (
              <span className={s.skipNote}>
                {' '}— skipped {preview.skipped} row(s)
                {preview.skippedNoUrl > 0 && ` (${preview.skippedNoUrl} with no Internet hyperlink)`}
              </span>
            )}
            :
          </p>
          <div className={s.list}>
            {preview.websites.slice(0, 8).map((w, i) => {
              const tags = [
                w.domain && `Domain: ${w.domain}`,
                w.srms_owner && `Owner: ${w.srms_owner}`,
                w.srms && `SRMS: ${w.srms}`,
              ].filter(Boolean);
              return (
                <div key={i} className={s.previewItem}>
                  <span className={s.previewName}>{w.name || '—'}</span>
                  <span className={s.previewUrl}>{w.url}</span>
                  {tags.length > 0 && (
                    <span className={s.previewMeta}>{tags.join(' · ')}</span>
                  )}
                </div>
              );
            })}
            {preview.websites.length > 8 && (
              <p className={s.more}>… and {preview.websites.length - 8} more</p>
            )}
          </div>
          <div className={s.actions}>
            <button className={s.importBtn} onClick={handleImport} disabled={importing}>
              {importing ? 'Importing…' : `Import all ${preview.count}`}
            </button>
            <button className={s.cancelBtn} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
