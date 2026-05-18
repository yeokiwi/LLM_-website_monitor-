import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { stripMarkdown, isMarkdownReport } from '../pages/ReportPage';
import s from './ScanResultCard.module.css';

const STATUS_LABELS = {
  completed:  { label: 'Changes Found',   cls: s.completed },
  no_changes: { label: 'No Changes',       cls: s.noChanges },
  no_history: { label: 'Initial Report',   cls: s.noHistory },
  error:      { label: 'Error',            cls: s.error },
  running:    { label: 'Running…',         cls: s.running },
};

const PREVIEW_CHARS = 320;

export default function ScanResultCard({ result }) {
  const [expanded, setExpanded] = useState(result.status === 'completed');
  const meta = STATUS_LABELS[result.status] || { label: result.status, cls: '' };

  // Support both snake_case (DB results) and camelCase (live scan results)
  const summary = result.llm_summary || result.llmSummary || '';
  const diffSummary = result.diff_summary || result.diffSummary || '';

  // Scan ID — from DB it's `id`, from live POST response it's `scanId`
  const scanId = result.id || result.scanId;
  const hasReport = !!summary;
  const hasMarkdown = isMarkdownReport(summary);

  // Generate a short plain-text preview from the markdown
  const preview = hasMarkdown
    ? stripMarkdown(summary).slice(0, PREVIEW_CHARS)
    : summary.slice(0, PREVIEW_CHARS);

  const previewTruncated = preview.length >= PREVIEW_CHARS;

  return (
    <div className={s.card}>
      <div className={s.header} onClick={() => setExpanded((v) => !v)}>
        <div className={s.headerLeft}>
          <span className={`${s.badge} ${meta.cls}`}>{meta.label}</span>
          <div className={s.site}>
            <span className={s.siteName}>{result.name || result.url}</span>
            {result.name && <span className={s.siteUrl}>{result.url}</span>}
            {(result.domain || result.srms_owner || result.srms) && (
              <div className={s.meta}>
                {result.domain && (
                  <span className={s.metaChip}>Domain: {result.domain}</span>
                )}
                {result.srms_owner && (
                  <span className={s.metaChip}>Owner: {result.srms_owner}</span>
                )}
                {result.srms && (
                  <span className={s.metaChip} title={result.srms}>SRMS: {result.srms}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className={s.headerRight}>
          {diffSummary && (
            <span className={s.diffBadge}>{diffSummary}</span>
          )}
          <span className={s.period}>{result.period_days}d period</span>
          <span className={s.date}>{new Date(result.scanned_at).toLocaleString()}</span>
          <span className={s.toggle}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className={s.body}>
          {/* Completed or first-scan with an LLM report */}
          {(result.status === 'completed' || result.status === 'no_history') && hasReport && (
            <div className={s.summary}>
              <div className={s.summaryTitleRow}>
                <h4 className={s.summaryTitle}>
                  {hasMarkdown ? 'Change Report' : 'LLM Summary'}
                </h4>
                {scanId && (
                  <Link to={`/report/${scanId}`} className={s.viewReportLink}>
                    View full report →
                  </Link>
                )}
              </div>

              {hasMarkdown ? (
                <div className={s.previewBox}>
                  <p className={s.previewText}>
                    {preview}{previewTruncated && '…'}
                  </p>
                  {scanId && (
                    <Link to={`/report/${scanId}`} className={s.previewMoreLink}>
                      Read full structured report →
                    </Link>
                  )}
                </div>
              ) : (
                <div className={s.summaryText}>{summary}</div>
              )}
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
