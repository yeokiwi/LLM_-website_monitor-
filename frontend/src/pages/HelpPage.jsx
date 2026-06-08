import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import s from './HelpPage.module.css';

// ---------------------------------------------------------------------------
// Table of contents definition — drives both the sidebar and section anchors
// ---------------------------------------------------------------------------
const TOC = [
  { id: 'overview',       label: 'Overview' },
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'adding-sites',   label: 'Adding Websites' },
  { id: 'running-scans',  label: 'Running Scans' },
  { id: 'scan-results',   label: 'Understanding Results' },
  { id: 'reports',        label: 'Change Reports' },
  { id: 'history',        label: 'Scan History' },
  { id: 'configuration',  label: 'Configuration' },
  { id: 'faq',            label: 'FAQ' },
];

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Section({ id, icon, title, children }) {
  return (
    <section id={id} className={s.section}>
      <h2 className={s.sectionTitle}>
        {icon && <span className={s.sectionIcon}>{icon}</span>}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Step({ n, title, children }) {
  return (
    <div className={s.step}>
      <div className={s.stepNum}>{n}</div>
      <div className={s.stepBody}>
        {title && <strong className={s.stepTitle}>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

function Callout({ type = 'info', children }) {
  const icons = { info: 'ℹ️', tip: '💡', warning: '⚠️', success: '✅' };
  return (
    <div className={`${s.callout} ${s[type]}`}>
      <span className={s.calloutIcon}>{icons[type]}</span>
      <div>{children}</div>
    </div>
  );
}

function Badge({ label, variant }) {
  return <span className={`${s.badge} ${s[variant]}`}>{label}</span>;
}

function KbdShortcut({ keys }) {
  return (
    <span className={s.kbdGroup}>
      {keys.map((k, i) => (
        <React.Fragment key={k}>
          {i > 0 && <span className={s.kbdPlus}>+</span>}
          <kbd className={s.kbd}>{k}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function HelpPage() {
  const [active, setActive] = useState('overview');

  // Highlight the active TOC item as the user scrolls
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { setActive(e.target.id); break; }
        }
      },
      { rootMargin: '-10% 0px -75% 0px' }
    );
    TOC.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div className={s.layout}>
      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      <aside className={s.sidebar}>
        <div className={s.sidebarInner}>
          <p className={s.tocLabel}>User Guide</p>
          <nav className={s.toc}>
            {TOC.map(({ id, label }) => (
              <button
                key={id}
                className={`${s.tocItem} ${active === id ? s.tocActive : ''}`}
                onClick={() => scrollTo(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </aside>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <main className={s.main}>

        {/* ── 1. Overview ─────────────────────────────────────────────────── */}
        <Section id="overview" icon="🔍" title="Overview">
          <p className={s.lead}>
            <strong>Website Monitor</strong> is an LLM-powered tool that autonomously tracks changes
            across websites and produces structured, easy-to-read change reports. Instead of just
            alerting you that a page changed, it tells you <em>what</em> changed — new releases,
            announcements, product updates, and policy changes — and distinguishes between confirmed
            and inferred recent activity.
          </p>

          <div className={s.featureGrid}>
            <div className={s.featureCard}>
              <span className={s.featureIcon}>🌐</span>
              <strong>Multi-source scraping</strong>
              <p>Uses Firecrawl (full-page markdown), Brave Search (web + news + announcements), or direct HTML fetching to gather the richest possible picture of a site.</p>
            </div>
            <div className={s.featureCard}>
              <span className={s.featureIcon}>🤖</span>
              <strong>LLM analysis</strong>
              <p>Every scan produces a structured 6-section markdown report — not a raw diff dump.</p>
            </div>
            <div className={s.featureCard}>
              <span className={s.featureIcon}>📋</span>
              <strong>Navigable reports</strong>
              <p>Each report has a table of contents, anchor navigation, and a print/PDF option.</p>
            </div>
            <div className={s.featureCard}>
              <span className={s.featureIcon}>📅</span>
              <strong>Custom periods</strong>
              <p>Monitor over 30, 60, 90 days or any custom window — the LLM focuses its analysis on the period you choose.</p>
            </div>
            <div className={s.featureCard}>
              <span className={s.featureIcon}>📊</span>
              <strong>Bulk import</strong>
              <p>Upload an Excel or CSV file to add dozens of sites at once.</p>
            </div>
            <div className={s.featureCard}>
              <span className={s.featureIcon}>🔒</span>
              <strong>Authentication</strong>
              <p>Username/password login with JWT sessions keeps your monitoring data private.</p>
            </div>
          </div>
        </Section>

        <hr className={s.divider} />

        {/* ── 2. Getting Started ──────────────────────────────────────────── */}
        <Section id="getting-started" icon="🚀" title="Getting Started">
          <Step n={1} title="Log in">
            Open the app in your browser. You'll see the login screen. Enter the
            credentials configured by your administrator (default username: <code className={s.code}>admin</code>).
          </Step>

          <Step n={2} title="Add your first website">
            On the <strong>Dashboard</strong>, use the <em>Add Website</em> form at the top.
            Paste the full URL (e.g. <code className={s.code}>https://example.com</code>) and
            an optional friendly name, then click <strong>Add</strong>.
          </Step>

          <Step n={3} title="Run your first scan">
            Tick the checkbox next to your new site, choose a monitoring period (e.g. 30 days),
            and click <strong>Scan Selected</strong>. The first scan records a baseline — you'll
            receive an <Badge label="Initial Report" variant="noHistory" /> with an LLM analysis
            of what the site currently looks like.
          </Step>

          <Step n={4} title="Run a second scan later">
            After the site has had time to accumulate changes (or immediately to test), scan again.
            If anything changed you'll get a <Badge label="Changes Found" variant="completed" /> card
            with a full structured report. Click <strong>View full report →</strong> to open it.
          </Step>

          <Callout type="tip">
            Sessions last 24 hours by default. You'll be redirected to the login page automatically
            when your session expires.
          </Callout>
        </Section>

        <hr className={s.divider} />

        {/* ── 3. Adding Websites ──────────────────────────────────────────── */}
        <Section id="adding-sites" icon="➕" title="Adding Websites">

          <h3 className={s.subTitle}>Single URL</h3>
          <ol className={s.ol}>
            <li>In the <strong>Add a website</strong> form, enter the full URL including <code className={s.code}>https://</code>.</li>
            <li>Optionally add a short name (shown in reports and cards).</li>
            <li>Click <strong>Add</strong>. The site appears in the list immediately.</li>
          </ol>

          <h3 className={s.subTitle}>Bulk import via Excel / CSV</h3>
          <ol className={s.ol}>
            <li>Prepare a spreadsheet with a column named <code className={s.code}>url</code> (required) and optionally <code className={s.code}>name</code>.</li>
            <li>Click <strong>Upload Excel / CSV</strong> and select your file, or drag and drop it onto the upload zone.</li>
            <li>The app parses every row and adds all valid URLs at once.</li>
          </ol>

          <Callout type="info">
            Duplicate URLs are silently ignored — re-uploading a sheet won't create
            duplicate entries.
          </Callout>

          <h3 className={s.subTitle}>Removing a website</h3>
          <p className={s.p}>
            Click the <strong>Delete</strong> button (🗑) next to any site in the list.
            The site and all its historical scans are soft-deleted and will no longer
            appear in the dashboard.
          </p>
        </Section>

        <hr className={s.divider} />

        {/* ── 4. Running Scans ────────────────────────────────────────────── */}
        <Section id="running-scans" icon="▶️" title="Running Scans">

          <h3 className={s.subTitle}>Selecting websites</h3>
          <ul className={s.ul}>
            <li>Tick individual checkboxes to select specific sites.</li>
            <li>Use the <strong>Select All</strong> header checkbox to select every site at once.</li>
            <li>The scan button label shows how many sites are selected.</li>
          </ul>

          <h3 className={s.subTitle}>Choosing a monitoring period</h3>
          <p className={s.p}>
            The period tells the LLM how far back to look when assessing what's "recent". The scraper
            also uses it to tune search freshness — shorter periods return fresher results.
          </p>

          <div className={s.periodTable}>
            <div className={s.periodRow}>
              <span className={s.periodVal}>30 days</span>
              <span className={s.periodDesc}>Default. Good for active sites that update weekly.</span>
            </div>
            <div className={s.periodRow}>
              <span className={s.periodVal}>60 days</span>
              <span className={s.periodDesc}>Useful for moderately active sites or quarterly reviews.</span>
            </div>
            <div className={s.periodRow}>
              <span className={s.periodVal}>90 days</span>
              <span className={s.periodDesc}>Best for slow-moving sites or policy/ToS monitoring.</span>
            </div>
            <div className={s.periodRow}>
              <span className={s.periodVal}>Custom</span>
              <span className={s.periodDesc}>Type any value (1–3650 days) in the period selector.</span>
            </div>
          </div>

          <h3 className={s.subTitle}>What happens during a scan</h3>
          <div className={s.pipeline}>
            <div className={s.pipelineStep}>
              <span className={s.pipelineNum}>1</span>
              <span><strong>Scrape</strong> — Firecrawl (full-page markdown), Brave search (web + news + announcements), or direct HTML fetch</span>
            </div>
            <div className={s.pipelineArrow}>↓</div>
            <div className={s.pipelineStep}>
              <span className={s.pipelineNum}>2</span>
              <span><strong>Snapshot</strong> — Content is hashed and saved to the database</span>
            </div>
            <div className={s.pipelineArrow}>↓</div>
            <div className={s.pipelineStep}>
              <span className={s.pipelineNum}>3</span>
              <span><strong>Diff</strong> — New snapshot compared against baseline from the chosen period</span>
            </div>
            <div className={s.pipelineArrow}>↓</div>
            <div className={s.pipelineStep}>
              <span className={s.pipelineNum}>4</span>
              <span><strong>LLM Analysis</strong> — Structured 6-section markdown report generated</span>
            </div>
            <div className={s.pipelineArrow}>↓</div>
            <div className={s.pipelineStep}>
              <span className={s.pipelineNum}>5</span>
              <span><strong>Result</strong> — Report stored and displayed as a result card</span>
            </div>
          </div>

          <Callout type="info">
            Multiple selected sites are scanned <strong>sequentially</strong> (not in parallel) to
            stay within LLM API rate limits. Large batches may take a few minutes.
          </Callout>
        </Section>

        <hr className={s.divider} />

        {/* ── 5. Understanding Results ────────────────────────────────────── */}
        <Section id="scan-results" icon="📊" title="Understanding Results">
          <p className={s.p}>Each scan produces a result card with a coloured status badge:</p>

          <div className={s.statusTable}>
            <div className={s.statusRow}>
              <Badge label="Changes Found" variant="completed" />
              <p>Content changed since the baseline. A full LLM report was generated. Click <strong>View full report →</strong> to read it.</p>
            </div>
            <div className={s.statusRow}>
              <Badge label="Initial Report" variant="noHistory" />
              <p>First scan for this site. The LLM analysed current indexed content to give you an immediate baseline report. Subsequent scans will compare against this.</p>
            </div>
            <div className={s.statusRow}>
              <Badge label="No Changes" variant="noChanges" />
              <p>Content hash matched the baseline exactly. No LLM call was made (saves tokens). The site has not changed during the monitored period.</p>
            </div>
            <div className={s.statusRow}>
              <Badge label="Error" variant="error" />
              <p>The scraper could not fetch the site, or the LLM call failed. Expand the card to see the error message.</p>
            </div>
          </div>

          <h3 className={s.subTitle}>Diff badge</h3>
          <p className={s.p}>
            Cards with a <span className={s.diffChip}>+42 lines / -7 lines</span> chip show a rough
            line-level change count from the raw diff. This is a quick signal of <em>how much</em>{' '}
            changed; the LLM report explains <em>what</em> changed.
          </p>

          <h3 className={s.subTitle}>Expanding a card</h3>
          <p className={s.p}>
            Click anywhere on the card header to expand or collapse it. Completed and initial-report
            cards open by default. The body shows a 320-character plain-text preview of the report
            plus a link to the full report page.
          </p>
        </Section>

        <hr className={s.divider} />

        {/* ── 6. Change Reports ───────────────────────────────────────────── */}
        <Section id="reports" icon="📄" title="Change Reports">
          <p className={s.p}>
            Click <strong>View full report →</strong> on any completed card to open the full report
            at <code className={s.code}>/report/:id</code>. Every report follows the same six-section
            structure:
          </p>

          <div className={s.reportSections}>
            <div className={s.reportSection}>
              <span className={s.reportSectionNum}>1</span>
              <div>
                <strong>Executive Summary</strong>
                <p>2–3 sentences covering the overall picture. Good for a quick answer to "did anything important happen?"</p>
              </div>
            </div>
            <div className={s.reportSection}>
              <span className={s.reportSectionNum}>2</span>
              <div>
                <strong>What's New or Changed</strong>
                <p>Bullet list of the most notable changes. Dates are included when the source data contains them.</p>
              </div>
            </div>
            <div className={s.reportSection}>
              <span className={s.reportSectionNum}>3</span>
              <div>
                <strong>Announcements & New Releases</strong>
                <p>Press releases, product launches, version releases, blog posts, and official announcements found during the period.</p>
              </div>
            </div>
            <div className={s.reportSection}>
              <span className={s.reportSectionNum}>4</span>
              <div>
                <strong>Product, Service & Feature Updates</strong>
                <p>Changes to products, services, pricing models, or individual features.</p>
              </div>
            </div>
            <div className={s.reportSection}>
              <span className={s.reportSectionNum}>5</span>
              <div>
                <strong>Policy & Terms Changes</strong>
                <p>Updates to terms of service, privacy policy, cookie policy, or any legal/compliance documents.</p>
              </div>
            </div>
            <div className={s.reportSection}>
              <span className={s.reportSectionNum}>6</span>
              <div>
                <strong>Confidence Assessment</strong>
                <p>Separates items the LLM can <em>confirm</em> are recent (explicit dates in the source) from items that <em>appear</em> recent (contextually inferred).</p>
              </div>
            </div>
          </div>

          <h3 className={s.subTitle}>Navigating a report</h3>
          <ul className={s.ul}>
            <li>The <strong>left sidebar</strong> shows a table of contents. Click any entry to scroll directly to that section.</li>
            <li>The <strong>active section</strong> is highlighted in the TOC as you scroll.</li>
            <li>The <strong>← Back</strong> button returns you to the previous page.</li>
            <li>The <strong>Print / Save PDF</strong> button opens the browser print dialog. The sidebar is automatically hidden in the printed output.</li>
          </ul>

          <Callout type="tip">
            If a section says <em>"Nothing detected for this period."</em> it means the LLM found no
            evidence of that type of change in the scraped content — not that the site is inactive.
          </Callout>
        </Section>

        <hr className={s.divider} />

        {/* ── 7. Scan History ─────────────────────────────────────────────── */}
        <Section id="history" icon="🗂️" title="Scan History">
          <p className={s.p}>
            The <strong>Scan History</strong> page (accessible from the top navigation) shows a
            paginated log of every scan ever run, sorted newest first.
          </p>
          <ul className={s.ul}>
            <li>10 results per page. Use <strong>Previous</strong> / <strong>Next</strong> to navigate.</li>
            <li>The total scan count is shown above the results.</li>
            <li>Each card behaves identically to the Dashboard cards — click to expand, use the report link.</li>
            <li>History is never automatically deleted; it accumulates as an audit trail.</li>
          </ul>

          <Callout type="info">
            To find scans for a specific website, use your browser's
            {' '}<KbdShortcut keys={['Ctrl', 'F']} /> (or <KbdShortcut keys={['⌘', 'F']} /> on Mac)
            and search for the site name or URL.
          </Callout>
        </Section>

        <hr className={s.divider} />

        {/* ── 8. Configuration ────────────────────────────────────────────── */}
        <Section id="configuration" icon="⚙️" title="Configuration">
          <p className={s.p}>
            All configuration is done via environment variables in <code className={s.code}>backend/.env</code>.
            Copy <code className={s.code}>backend/.env.example</code> as a starting point.
          </p>

          <h3 className={s.subTitle}>Authentication</h3>
          <div className={s.envTable}>
            <div className={s.envRow}><code className={s.envKey}>AUTH_USERNAME</code><span>Login username. Default: <code className={s.code}>admin</code></span></div>
            <div className={s.envRow}><code className={s.envKey}>AUTH_PASSWORD</code><span><strong>Required.</strong> Login password. No default.</span></div>
            <div className={s.envRow}><code className={s.envKey}>JWT_SECRET</code><span>Secret used to sign tokens. Use a long random string in production.</span></div>
            <div className={s.envRow}><code className={s.envKey}>JWT_EXPIRES_IN</code><span>Session lifetime. Default: <code className={s.code}>24h</code>. Examples: <code className={s.code}>7d</code>, <code className={s.code}>30d</code></span></div>
          </div>

          <Callout type="warning">
            Generate a secure <code className={s.code}>JWT_SECRET</code> with:
            {' '}<code className={s.codeBlock}>node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"</code>
          </Callout>

          <h3 className={s.subTitle}>LLM Provider</h3>
          <div className={s.envTable}>
            <div className={s.envRow}><code className={s.envKey}>LLM_PROVIDER</code><span><code className={s.code}>claude</code> for Anthropic, or any other value for an OpenAI-compatible endpoint.</span></div>
            <div className={s.envRow}><code className={s.envKey}>LLM_MODEL</code><span>Model name. Defaults: <code className={s.code}>claude-opus-4-6</code> (Claude) / <code className={s.code}>gpt-4o</code> (OpenAI).</span></div>
            <div className={s.envRow}><code className={s.envKey}>ANTHROPIC_API_KEY</code><span>Required when <code className={s.code}>LLM_PROVIDER=claude</code>.</span></div>
            <div className={s.envRow}><code className={s.envKey}>OPENAI_API_KEY</code><span>Required for hosted OpenAI-compatible services.</span></div>
            <div className={s.envRow}><code className={s.envKey}>OPENAI_BASE_URL</code><span>Base URL for the OpenAI-compatible endpoint (Ollama, Groq, Together, etc.).</span></div>
          </div>

          <h3 className={s.subTitle}>Supported LLM providers</h3>
          <div className={s.providerGrid}>
            {[
              ['Anthropic Claude', 'https://api.anthropic.com', 'claude'],
              ['OpenAI', 'https://api.openai.com/v1', 'openai'],
              ['Ollama (local)', 'http://localhost:11434/v1', 'ollama'],
              ['LM Studio (local)', 'http://localhost:1234/v1', 'lmstudio'],
              ['Groq', 'https://api.groq.com/openai/v1', 'groq'],
              ['Together AI', 'https://api.together.xyz/v1', 'together'],
              ['Mistral AI', 'https://api.mistral.ai/v1', 'mistral'],
              ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek'],
              ['Perplexity', 'https://api.perplexity.ai', 'perplexity'],
            ].map(([name, url]) => (
              <div key={name} className={s.providerCard}>
                <strong>{name}</strong>
                <code className={s.providerUrl}>{url}</code>
              </div>
            ))}
          </div>

          <h3 className={s.subTitle}>Web scraping</h3>
          <div className={s.envTable}>
            <div className={s.envRow}><code className={s.envKey}>SCRAPER_PROVIDER</code><span>Which scraper to use: <code className={s.code}>firecrawl</code>, <code className={s.code}>brave</code>, or <code className={s.code}>auto</code> (default). <code className={s.code}>auto</code> picks Firecrawl, then Brave, then direct scraping based on which key is set.</span></div>
            <div className={s.envRow}><code className={s.envKey}>FIRECRAWL_API_KEY</code><span>Enables Firecrawl full-page markdown scraping — captures the actual rendered page for the richest diffs.</span></div>
            <div className={s.envRow}><code className={s.envKey}>FIRECRAWL_BASE_URL</code><span>Optional. Override the Firecrawl API base (e.g. a self-hosted instance).</span></div>
            <div className={s.envRow}><code className={s.envKey}>BRAVE_API_KEY</code><span>Enables Brave Search API (indexed content). Falls back to direct HTML scraping when no provider key is set.</span></div>
          </div>

          <Callout type="tip">
            Firecrawl returns clean full-page markdown of the rendered page — ideal for detecting
            real content changes. The Brave Search API instead provides indexed pages with
            publication dates, news results, and announcement pages. Get a Firecrawl key at
            <strong> firecrawl.dev</strong> or a free Brave key at <strong>api.search.brave.com</strong>.
          </Callout>

          <h3 className={s.subTitle}>Database</h3>
          <div className={s.envTable}>
            <div className={s.envRow}><code className={s.envKey}>DB_PATH</code><span>Path to the SQLite file. Default: <code className={s.code}>./data/monitor.db</code>. Created automatically on first run.</span></div>
          </div>
        </Section>

        <hr className={s.divider} />

        {/* ── 9. FAQ ──────────────────────────────────────────────────────── */}
        <Section id="faq" icon="❓" title="FAQ">

          <details className={s.faq}>
            <summary className={s.faqQ}>Why does the first scan say "Initial Report" instead of "Changes Found"?</summary>
            <p className={s.faqA}>
              The first scan has nothing to compare against, so there is no diff. Instead, the LLM
              analyses the current indexed content and produces an initial report of what appears to
              have happened in the past N days. The next scan will compare against this baseline and
              produce a proper "Changes Found" report.
            </p>
          </details>

          <details className={s.faq}>
            <summary className={s.faqQ}>Why does a scan show "No Changes" even though the site clearly updated?</summary>
            <p className={s.faqA}>
              "No Changes" means the scraped <em>content hash</em> is identical to the baseline.
              This can happen when: (a) the change is in a part of the page the scraper ignores
              (e.g. dynamic JavaScript content), (b) without a Firecrawl or Brave API key the
              scraper only fetches the homepage, or (c) the change happened before the monitoring
              period you selected. Try enabling Firecrawl or the Brave API for more comprehensive
              coverage.
            </p>
          </details>

          <details className={s.faq}>
            <summary className={s.faqQ}>How do I change the login credentials?</summary>
            <p className={s.faqA}>
              Update <code className={s.code}>AUTH_USERNAME</code> and <code className={s.code}>AUTH_PASSWORD</code> in
              your <code className={s.code}>backend/.env</code> file and restart the server. Existing
              JWT tokens will still work until they expire (default 24h).
            </p>
          </details>

          <details className={s.faq}>
            <summary className={s.faqQ}>Can I run this with a local LLM?</summary>
            <p className={s.faqA}>
              Yes. Set <code className={s.code}>LLM_PROVIDER=ollama</code> (or any non-<code className={s.code}>claude</code> value),
              set <code className={s.code}>OPENAI_BASE_URL=http://localhost:11434/v1</code>, and set
              <code className={s.code}>LLM_MODEL</code> to your local model name (e.g. <code className={s.code}>llama3.2</code>).
              The <code className={s.code}>OPENAI_API_KEY</code> can be any non-empty string for local models.
            </p>
          </details>

          <details className={s.faq}>
            <summary className={s.faqQ}>How do I export or print a report?</summary>
            <p className={s.faqA}>
              Open the full report at <code className={s.code}>/report/:id</code> and click
              <strong> Print / Save PDF</strong> in the left sidebar. The browser print dialog
              opens; choose "Save as PDF" as the destination. The sidebar TOC is hidden in the
              printed output for a clean result.
            </p>
          </details>

          <details className={s.faq}>
            <summary className={s.faqQ}>How is my data stored?</summary>
            <p className={s.faqA}>
              Everything is stored locally in a SQLite database file at the path set by
              <code className={s.code}> DB_PATH</code> (default <code className={s.code}>backend/data/monitor.db</code>).
              No data is sent anywhere except to the LLM API you configure and (optionally) the
              Firecrawl or Brave Search API.
            </p>
          </details>

          <details className={s.faq}>
            <summary className={s.faqQ}>What does the status indicator in the top-right corner mean?</summary>
            <p className={s.faqA}>
              The green/red dot and text (e.g. <em>claude · brave</em>) shows the active LLM
              provider and scraper method. Green means the backend is healthy. If the dot is red,
              check the backend logs for configuration errors.
            </p>
          </details>

        </Section>

        <div className={s.footer}>
          <p>Website Monitor — LLM-powered change tracking</p>
          <Link to="/" className={s.footerLink}>← Back to Dashboard</Link>
        </div>

      </main>
    </div>
  );
}
