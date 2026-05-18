const express = require('express');
const db = require('../db');
const { scrapeWebsite } = require('../services/scraper');
const { saveSnapshot, findBaselineSnapshot, getSnapshot } = require('../services/snapshotService');
const { computeDiff } = require('../services/diffService');
const { summarizeChanges } = require('../services/llmService');

const router = express.Router();

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
// ---------------------------------------------------------------------------
async function runSingleScan(website, periodDays) {
  let newSnapshot = null;

  try {
    // 1. Scrape current content (period-aware for freshness tuning)
    const { contentText, source, pages } = await scrapeWebsite(website.url, periodDays);

    // 2. Save new snapshot
    newSnapshot = saveSnapshot(website.id, contentText);

    // 3. Find baseline snapshot from the specified period
    const oldSnapshot = findBaselineSnapshot(website.id, periodDays);

    // --- First scan: no history — run an initial analysis report ---
    if (!oldSnapshot || oldSnapshot.id === newSnapshot.id) {
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

    // 4. Check if content changed
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
        `No changes detected on ${website.url} over the past ${periodDays} day(s).`
      );

      return {
        scanId: result.lastInsertRowid,
        websiteId: website.id,
        url: website.url,
        status: 'no_changes',
        source,
      };
    }

    // 5. Produce structured LLM analysis report
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

    // 6. Save completed result
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
