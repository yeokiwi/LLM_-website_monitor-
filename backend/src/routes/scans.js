const express = require('express');
const db = require('../db');
const { scrapeWebsite, scrapeWithProvider, scrapePdf, isPdfUrl } = require('../services/scraper');
const { saveSnapshot, findBaselineSnapshot, getPreviousSnapshot, getSnapshot } = require('../services/snapshotService');
const { computeDiff } = require('../services/diffService');
const { summarizeChanges } = require('../services/llmService');
const { buildReportsPdf } = require('../services/reportPdf');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/scans/export-pdf — export every scan report as one PDF file
//
// Available to any authenticated user (scanning + viewing history). Optionally
// accepts `?ids=1,2,3` to export a specific subset (e.g. the filtered view on
// the history page); when omitted, all scan reports are exported.
//
// NOTE: must be declared before `GET /:id` so the literal path is not captured
// by the `:id` parameter route.
// ---------------------------------------------------------------------------
router.get('/export-pdf', async (req, res) => {
  const baseQuery = `
    SELECT sr.*, w.url, w.name, w.domain, w.srms_owner, w.srms
    FROM scan_results sr
    JOIN websites w ON sr.website_id = w.id
  `;

  let scans;
  const idsParam = (req.query.ids || '').trim();
  if (idsParam) {
    const ids = idsParam
      .split(',')
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid scan ids provided' });
    }
    const placeholders = ids.map(() => '?').join(',');
    scans = db
      .prepare(`${baseQuery} WHERE sr.id IN (${placeholders}) ORDER BY sr.scanned_at DESC`)
      .all(...ids);
  } else {
    scans = db.prepare(`${baseQuery} ORDER BY sr.scanned_at DESC`).all();
  }

  try {
    const pdf = await buildReportsPdf(scans);
    const filename = `scan-reports-${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    console.error('Failed to build reports PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/scans — list all scan results (paginated)
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const results = db
    .prepare(
      `
      SELECT sr.*, w.url, w.name, w.domain, w.srms_owner, w.srms
      FROM scan_results sr
      JOIN websites w ON sr.website_id = w.id
      ORDER BY sr.scanned_at DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(limit, offset);

  const total = db
    .prepare('SELECT COUNT(*) as count FROM scan_results')
    .get().count;

  res.json({ total, limit, offset, results });
});

// ---------------------------------------------------------------------------
// GET /api/scans/:id — single scan result
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const scan = db
    .prepare(
      `
      SELECT sr.*, w.url, w.name, w.domain, w.srms_owner, w.srms
      FROM scan_results sr
      JOIN websites w ON sr.website_id = w.id
      WHERE sr.id = ?
    `
    )
    .get(req.params.id);

  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

// ---------------------------------------------------------------------------
// GET /api/scans/website/:websiteId — scans for one website
// ---------------------------------------------------------------------------
router.get('/website/:websiteId', (req, res) => {
  const scans = db
    .prepare(
      `
      SELECT * FROM scan_results
      WHERE website_id = ?
      ORDER BY scanned_at DESC
      LIMIT 50
    `
    )
    .all(req.params.websiteId);

  res.json(scans);
});

// ---------------------------------------------------------------------------
// PATCH /api/scans/:id — save a user remark/comment on a scan result
// Body: { remark: string }
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const { remark } = req.body;
  if (remark === undefined) {
    return res.status(400).json({ error: 'remark is required' });
  }

  const result = db
    .prepare('UPDATE scan_results SET remark = ? WHERE id = ?')
    .run(remark === null ? null : String(remark), req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Scan not found' });
  }

  const scan = db.prepare('SELECT * FROM scan_results WHERE id = ?').get(req.params.id);
  res.json(scan);
});

// ---------------------------------------------------------------------------
// POST /api/scans — trigger a scan
// Body: { websiteIds: number[], periodDays: number }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { websiteIds, periodDays } = req.body;

  if (!Array.isArray(websiteIds) || websiteIds.length === 0) {
    return res.status(400).json({ error: 'websiteIds must be a non-empty array' });
  }

  const period = parseInt(periodDays) || 30;
  if (period < 1 || period > 3650) {
    return res.status(400).json({ error: 'periodDays must be between 1 and 3650' });
  }

  // Look up websites
  const placeholders = websiteIds.map(() => '?').join(',');
  const websites = db
    .prepare(
      `SELECT * FROM websites WHERE id IN (${placeholders}) AND is_active = 1`
    )
    .all(...websiteIds);

  if (websites.length === 0) {
    return res.status(404).json({ error: 'No active websites found for the given IDs' });
  }

  // Run scans sequentially to respect LLM rate limits
  const scanResults = [];
  for (const website of websites) {
    const result = await runSingleScan(website, period);
    scanResults.push(result);
  }

  res.json({ scanned: scanResults.length, results: scanResults });
});

// ---------------------------------------------------------------------------
// Core scan logic for a single website
//
// Each website can opt into one or more scraper engines (Firecrawl / Brave).
// Every selected engine is scraped independently and diffed against its own
// provider-scoped history; the per-engine analyses are combined into a single
// report with one top-level "# <Engine> Results" section per engine.
// ---------------------------------------------------------------------------

const PROVIDER_SECTION_LABELS = {
  firecrawl: 'Firecrawl Results',
  brave: 'Brave Search Results',
  serper: 'Serper Search Results',
  direct: 'Direct Scrape Results',
};

const PROVIDER_SHORT_LABELS = {
  firecrawl: 'Firecrawl',
  brave: 'Brave',
  serper: 'Serper',
  direct: 'Direct',
};

/**
 * Scrape, snapshot, diff and summarise a single website with one engine.
 * @returns {{ status, markdown, newSnapshotId, oldSnapshotId, diffSummary }}
 */
async function scanOneProvider(website, periodDays, provider) {
  const { contentText, pages } = await scrapeWithProvider(provider, website.url, periodDays);

  const snap = saveSnapshot(website.id, contentText, provider);
  const baseline = findBaselineSnapshot(website.id, periodDays, provider);

  // First scan for this engine — no history yet.
  if (!baseline || baseline.id === snap.id) {
    const md = await summarizeChanges({
      websiteUrl: website.url,
      websiteName: website.name,
      periodDays,
      oldContent: '',
      newContent: contentText,
      diffText: '',
      pages,
      isFirstScan: true,
    });
    return { status: 'no_history', markdown: md, newSnapshotId: snap.id, oldSnapshotId: null, diffSummary: null };
  }

  const { diffText, hasChanges, addedLines, removedLines } = computeDiff(
    baseline.content_text,
    contentText
  );

  if (!hasChanges) {
    return {
      status: 'no_changes',
      markdown: `No changes detected over the past ${periodDays} day(s).`,
      newSnapshotId: snap.id,
      oldSnapshotId: baseline.id,
      diffSummary: null,
    };
  }

  const md = await summarizeChanges({
    websiteUrl: website.url,
    websiteName: website.name,
    periodDays,
    oldContent: baseline.content_text,
    newContent: contentText,
    diffText,
    pages,
    isFirstScan: false,
  });

  return {
    status: 'completed',
    markdown: md,
    newSnapshotId: snap.id,
    oldSnapshotId: baseline.id,
    diffSummary: `+${addedLines}/-${removedLines}`,
  };
}

async function runSingleScan(website, periodDays) {
  // PDFs are scanned as documents only (search/scrape engines bypassed) and
  // diffed against the previous scan rather than the period baseline.
  let pdf = false;
  try { pdf = await isPdfUrl(website.url); } catch { /* treat as non-PDF */ }
  if (pdf) {
    return runPdfScan(website, periodDays);
  }

  // Build the list of engines this website opted into, gated by configured keys.
  const providers = [];
  if (website.use_firecrawl && process.env.FIRECRAWL_API_KEY) providers.push('firecrawl');
  if (website.use_brave && process.env.BRAVE_API_KEY) providers.push('brave');
  if (website.use_serper && process.env.SERPER_API_KEY) providers.push('serper');

  // No engine selected/available → fall back to a single direct scrape (legacy).
  const usingFallback = providers.length === 0;
  if (usingFallback) providers.push('direct');

  const sections = [];
  const statuses = [];
  const diffParts = [];
  let primaryNewSnapshotId = null;
  let primaryOldSnapshotId = null;
  let lastError = null;

  for (const provider of providers) {
    let body;
    let status;
    try {
      const r = await scanOneProvider(website, periodDays, provider);
      body = r.markdown;
      status = r.status;
      if (primaryNewSnapshotId === null) {
        primaryNewSnapshotId = r.newSnapshotId;
        primaryOldSnapshotId = r.oldSnapshotId;
      }
      if (r.diffSummary) diffParts.push(`${PROVIDER_SHORT_LABELS[provider]}: ${r.diffSummary}`);
    } catch (err) {
      console.error(`Scan failed for ${website.url} [${provider}]:`, err.message);
      body = `**Error:** ${err.message}`;
      status = 'error';
      lastError = err;
    }
    statuses.push(status);
    sections.push(usingFallback ? body : `# ${PROVIDER_SECTION_LABELS[provider]}\n\n${body}`);
  }

  const combined = sections.join('\n\n');

  // Aggregate the per-engine outcomes into one row-level status.
  let status;
  if (statuses.includes('completed')) status = 'completed';
  else if (statuses.includes('no_history')) status = 'no_history';
  else if (statuses.every((st) => st === 'no_changes')) status = 'no_changes';
  else status = 'error';

  // Every engine failed before saving a snapshot — mirror the legacy behaviour
  // (no row inserted because new_snapshot_id is NOT NULL).
  if (primaryNewSnapshotId === null) {
    return {
      scanId: null,
      websiteId: website.id,
      url: website.url,
      status: 'error',
      error: lastError ? lastError.message : 'Scan failed',
    };
  }

  const diffSummary = diffParts.length ? diffParts.join(' · ') : null;

  const result = db.prepare(
    `INSERT INTO scan_results (website_id, period_days, old_snapshot_id, new_snapshot_id, diff_summary, llm_summary, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(website.id, periodDays, primaryOldSnapshotId, primaryNewSnapshotId, diffSummary, combined, status);

  return {
    scanId: result.lastInsertRowid,
    websiteId: website.id,
    url: website.url,
    status,
    llm_summary: combined,
    diff_summary: diffSummary,
    source: providers.join('+'),
  };
}

// ---------------------------------------------------------------------------
// PDF scan — the URL points to a PDF document. Only the PDF text is scanned
// (search/scrape engines are bypassed) and it is compared against the previous
// scan's snapshot so the report reflects changes *since the last scan*.
// ---------------------------------------------------------------------------
async function runPdfScan(website, periodDays) {
  let newSnapshot = null;

  try {
    // Scrape the PDF document directly (no redundant content-type re-detection).
    const { contentText, source, pages } = await scrapePdf(website.url);

    newSnapshot = saveSnapshot(website.id, contentText, 'pdf');

    // Compare against the immediately preceding PDF scan, not the period baseline.
    const oldSnapshot = getPreviousSnapshot(website.id, newSnapshot.id, 'pdf');

    if (!oldSnapshot) {
      const llmSummary = await summarizeChanges({
        websiteUrl: website.url,
        websiteName: website.name,
        periodDays,
        oldContent: '',
        newContent: contentText,
        diffText: '',
        pages,
        isFirstScan: true,
      });

      const result = db.prepare(
        `INSERT INTO scan_results (website_id, period_days, new_snapshot_id, status, llm_summary)
         VALUES (?, ?, ?, 'no_history', ?)`
      ).run(website.id, periodDays, newSnapshot.id, llmSummary);

      return {
        scanId: result.lastInsertRowid,
        websiteId: website.id,
        url: website.url,
        status: 'no_history',
        llm_summary: llmSummary,
        source,
      };
    }

    const { diffText, hasChanges, addedLines, removedLines } = computeDiff(
      oldSnapshot.content_text,
      contentText
    );

    if (!hasChanges) {
      const result = db.prepare(
        `INSERT INTO scan_results (website_id, period_days, old_snapshot_id, new_snapshot_id, status, llm_summary)
         VALUES (?, ?, ?, ?, 'no_changes', ?)`
      ).run(
        website.id, periodDays, oldSnapshot.id, newSnapshot.id,
        `No changes detected in the PDF at ${website.url} since the last scan.`
      );

      return {
        scanId: result.lastInsertRowid,
        websiteId: website.id,
        url: website.url,
        status: 'no_changes',
        source,
      };
    }

    const llmSummary = await summarizeChanges({
      websiteUrl: website.url,
      websiteName: website.name,
      periodDays,
      oldContent: oldSnapshot.content_text,
      newContent: contentText,
      diffText,
      pages,
      isFirstScan: false,
    });

    const diffSummary = `+${addedLines} lines / -${removedLines} lines`;

    const result = db.prepare(
      `INSERT INTO scan_results (website_id, period_days, old_snapshot_id, new_snapshot_id, diff_summary, llm_summary, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`
    ).run(
      website.id, periodDays, oldSnapshot.id, newSnapshot.id,
      diffSummary,
      llmSummary
    );

    return {
      scanId: result.lastInsertRowid,
      websiteId: website.id,
      url: website.url,
      status: 'completed',
      llm_summary: llmSummary,
      diff_summary: diffSummary,
      source,
    };
  } catch (err) {
    console.error(`Scan failed for ${website.url}:`, err.message);

    let scanId = null;
    if (newSnapshot) {
      const result = db.prepare(
        `INSERT INTO scan_results (website_id, period_days, new_snapshot_id, status, error_message)
         VALUES (?, ?, ?, 'error', ?)`
      ).run(website.id, periodDays, newSnapshot.id, err.message);
      scanId = result.lastInsertRowid;
    }

    return {
      scanId,
      websiteId: website.id,
      url: website.url,
      status: 'error',
      error: err.message,
    };
  }
}

module.exports = router;
