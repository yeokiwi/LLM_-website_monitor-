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
      setError(err.response?.data?.error || 'Failed to parse file');
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
      setError(err.response?.data?.error || 'Import failed');
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
      <span className={s.hint}>Expected columns: <strong>URL</strong> (required), <strong>Name</strong> (optional)</span>

      {error && <p className={s.error}>{error}</p>}
      {success && <p className={s.success}>{success}</p>}

      {preview && (
        <div className={s.preview}>
          <p className={s.previewTitle}>
            Found <strong>{preview.count}</strong> valid website(s) in the file:
          </p>
          <div className={s.list}>
            {preview.websites.slice(0, 8).map((w, i) => (
              <div key={i} className={s.previewItem}>
                <span className={s.previewName}>{w.name || '—'}</span>
                <span className={s.previewUrl}>{w.url}</span>
              </div>
            ))}
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
