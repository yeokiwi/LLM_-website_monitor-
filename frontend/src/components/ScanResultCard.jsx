import React, { useState } from 'react';
import s from './ScanResultCard.module.css';

const STATUS_LABELS = {
  completed:  { label: 'Changes Found',   cls: s.completed },
  no_changes: { label: 'No Changes',       cls: s.noChanges },
  no_history: { label: 'First Scan',       cls: s.noHistory },
  error:      { label: 'Error',            cls: s.error },
  running:    { label: 'Running…',         cls: s.running },
};

export default function ScanResultCard({ result }) {
  const [expanded, setExpanded] = useState(result.status === 'completed');
  const meta = STATUS_LABELS[result.status] || { label: result.status, cls: '' };

  return (
    <div className={s.card}>
      <div className={s.header} onClick={() => setExpanded((v) => !v)}>
        <div className={s.headerLeft}>
          <span className={`${s.badge} ${meta.cls}`}>{meta.label}</span>
          <div className={s.site}>
            <span className={s.siteName}>{result.name || result.url}</span>
            {result.name && <span className={s.siteUrl}>{result.url}</span>}
          </div>
        </div>
        <div className={s.headerRight}>
          {result.diff_summary && (
            <span className={s.diffBadge}>{result.diff_summary}</span>
          )}
          <span className={s.period}>{result.period_days}d period</span>
          <span className={s.date}>{new Date(result.scanned_at).toLocaleString()}</span>
          <span className={s.toggle}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className={s.body}>
          {result.status === 'completed' && result.llm_summary && (
            <div className={s.summary}>
              <h4 className={s.summaryTitle}>LLM Summary</h4>
              <div className={s.summaryText}>{result.llm_summary}</div>
            </div>
          )}

          {result.status === 'no_history' && (
            <div className={s.info}>
              {result.llm_summary}
            </div>
          )}

          {result.status === 'no_changes' && (
            <div className={s.info}>No changes detected during this period.</div>
          )}

          {result.status === 'error' && (
            <div className={s.errorBox}>
              <strong>Error:</strong> {result.error_message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
