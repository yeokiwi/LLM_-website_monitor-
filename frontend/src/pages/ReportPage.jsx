import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getScan } from '../api/client';
import s from './ReportPage.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Parse ## headings from raw markdown to build a table of contents. */
function extractTOC(markdown) {
  const headings = [];
  for (const line of markdown.split('\n')) {
    const m2 = line.match(/^## (.+)$/);
    if (m2) { headings.push({ level: 2, text: m2[1].trim(), id: slugify(m2[1]) }); continue; }
    const m3 = line.match(/^### (.+)$/);
    if (m3) { headings.push({ level: 3, text: m3[1].trim(), id: slugify(m3[1]) }); }
  }
  return headings;
}

/** Strip common markdown syntax for plain-text previews. */
export function stripMarkdown(text = '') {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Determine whether a llm_summary field is a structured markdown report. */
export function isMarkdownReport(text = '') {
  return text.trimStart().startsWith('##');
}

// ---------------------------------------------------------------------------
// Custom react-markdown component overrides
// ---------------------------------------------------------------------------

/** Render h2 with a slug id so the TOC can scroll to it. */
function Heading2({ children }) {
  const text = Array.isArray(children) ? children.join('') : String(children ?? '');
  return <h2 id={slugify(text)} className={s.mdH2}>{children}</h2>;
}

function Heading3({ children }) {
  const text = Array.isArray(children) ? children.join('') : String(children ?? '');
  return <h3 id={slugify(text)} className={s.mdH3}>{children}</h3>;
}

const MD_COMPONENTS = {
  h2: Heading2,
  h3: Heading3,
  ul: ({ children }) => <ul className={s.mdUl}>{children}</ul>,
  ol: ({ children }) => <ol className={s.mdOl}>{children}</ol>,
  li: ({ children }) => <li className={s.mdLi}>{children}</li>,
  p: ({ children }) => <p className={s.mdP}>{children}</p>,
  strong: ({ children }) => <strong className={s.mdStrong}>{children}</strong>,
  hr: () => <hr className={s.mdHr} />,
  a: ({ href, children }) => (
    <a href={href} className={s.mdLink} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className={s.mdBlockquote}>{children}</blockquote>,
  code: ({ children }) => <code className={s.mdCode}>{children}</code>,
  table: ({ children }) => <div className={s.mdTableWrap}><table className={s.mdTable}>{children}</table></div>,
  th: ({ children }) => <th className={s.mdTh}>{children}</th>,
  td: ({ children }) => <td className={s.mdTd}>{children}</td>,
};

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_META = {
  completed:  { label: 'Changes Found',  cls: 'completed' },
  no_history: { label: 'Initial Report', cls: 'noHistory' },
  no_changes: { label: 'No Changes',     cls: 'noChanges' },
  error:      { label: 'Error',          cls: 'error' },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [scan, setScan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toc, setToc] = useState([]);
  const [activeSection, setActiveSection] = useState('');

  useEffect(() => {
    getScan(id)
      .then((data) => {
        setScan(data);
        if (data.llm_summary && isMarkdownReport(data.llm_summary)) {
          setToc(extractTOC(data.llm_summary));
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load report. It may not exist or you may need to log in again.');
        setLoading(false);
      });
  }, [id]);

  // Highlight the active TOC item as the user scrolls
  useEffect(() => {
    if (!toc.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );

    toc.forEach(({ id: hId }) => {
      const el = document.getElementById(hId);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [toc]);

  const scrollTo = useCallback((headingId) => {
    const el = document.getElementById(headingId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // ── Loading / error states ──
  if (loading) {
    return (
      <div className={s.statePage}>
        <div className={s.stateSpinner} />
        <p>Loading report…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className={s.statePage}>
        <p className={s.stateError}>{error}</p>
        <button className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>
      </div>
    );
  }
  if (!scan) return null;

  const siteName = scan.name || scan.url;
  const meta = STATUS_META[scan.status] || { label: scan.status, cls: '' };
  const hasMarkdown = scan.llm_summary && isMarkdownReport(scan.llm_summary);

  return (
    <div className={s.layout}>
      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <aside className={s.sidebar}>
        <div className={s.sidebarInner}>
          <button className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>

          {toc.length > 0 && (
            <>
              <p className={s.tocLabel}>Contents</p>
              <nav className={s.toc}>
                {toc.map((h) => (
                  <button
                    key={h.id}
                    className={`${s.tocItem} ${h.level === 3 ? s.tocSub : ''} ${activeSection === h.id ? s.tocActive : ''}`}
                    onClick={() => scrollTo(h.id)}
                    title={h.text}
                  >
                    {h.text}
                  </button>
                ))}
              </nav>
            </>
          )}

          <button className={s.printBtn} onClick={() => window.print()}>
            🖨 Print / Save PDF
          </button>
        </div>
      </aside>

      {/* ── Main report ────────────────────────────────────────────────── */}
      <main className={s.main}>
        {/* Report header card */}
        <div className={s.reportHeader}>
          <div className={s.reportMeta}>
            <span className={`${s.statusBadge} ${s[meta.cls]}`}>{meta.label}</span>
            <span className={s.periodChip}>{scan.period_days}-day period</span>
            {scan.diff_summary && (
              <span className={s.diffChip}>{scan.diff_summary}</span>
            )}
          </div>

          <h1 className={s.reportTitle}>{siteName}</h1>
          {scan.name && <p className={s.reportUrl}>{scan.url}</p>}

          <p className={s.reportDate}>
            Analysed on {new Date(scan.scanned_at).toLocaleString(undefined, {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </p>
        </div>

        {/* Report body */}
        <div className={s.reportBody}>
          {hasMarkdown ? (
            <div className={s.markdown}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {scan.llm_summary}
              </ReactMarkdown>
            </div>
          ) : scan.status === 'no_changes' ? (
            <div className={s.infoBox}>
              <span className={s.infoIcon}>✓</span>
              <div>
                <strong>No changes detected</strong>
                <p>The monitored content was identical to the baseline recorded {scan.period_days} day{scan.period_days === 1 ? '' : 's'} ago.</p>
              </div>
            </div>
          ) : scan.status === 'error' ? (
            <div className={s.errorBox}>
              <strong>Scan error</strong>
              <p>{scan.error_message}</p>
            </div>
          ) : scan.llm_summary ? (
            /* Plain-text legacy summary (pre-markdown reports) */
            <pre className={s.plainSummary}>{scan.llm_summary}</pre>
          ) : null}
        </div>
      </main>
    </div>
  );
}
