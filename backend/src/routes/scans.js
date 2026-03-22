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
      SELECT sr.*, w.url, w.name
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
      SELECT sr.*, w.url, w.name
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
// GET /api/websites/:websiteId/scans — scans for one website
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
  // Create a pending scan record
  const pending = db
    .prepare(
      `
      INSERT INTO scan_results (website_id, period_days, new_snapshot_id, status)
      VALUES (?, ?, 0, 'running')
    `
    )
    .run(website.id, periodDays);

  const scanId = pending.lastInsertRowid;

  try {
    // 1. Scrape current content
    const { contentText, source } = await scrapeWebsite(website.url);

    // 2. Save new snapshot
    const newSnapshot = saveSnapshot(website.id, contentText);

    // 3. Update scan record with new snapshot ID
    db.prepare('UPDATE scan_results SET new_snapshot_id = ? WHERE id = ?').run(
      newSnapshot.id,
      scanId
    );

    // 4. Find baseline snapshot from the specified period
    const oldSnapshot = findBaselineSnapshot(website.id, periodDays);

    // --- First scan: no history ---
    if (!oldSnapshot || oldSnapshot.id === newSnapshot.id) {
      db.prepare(
        `UPDATE scan_results
         SET status = 'no_history',
             llm_summary = ?
         WHERE id = ?`
      ).run(
        `This is the first scan for ${website.url}. A baseline snapshot has been recorded. Run the scan again after ${periodDays} day(s) to see changes.`,
        scanId
      );

      return { scanId, websiteId: website.id, url: website.url, status: 'no_history', source };
    }

    // 5. Check if content changed
    const { diffText, hasChanges, addedLines, removedLines } = computeDiff(
      oldSnapshot.content_text,
      contentText
    );

    if (!hasChanges) {
      db.prepare(
        `UPDATE scan_results
         SET old_snapshot_id = ?,
             status = 'no_changes',
             llm_summary = ?
         WHERE id = ?`
      ).run(
        oldSnapshot.id,
        `No changes detected on ${website.url} over the past ${periodDays} day(s).`,
        scanId
      );

      return {
        scanId,
        websiteId: website.id,
        url: website.url,
        status: 'no_changes',
        source,
      };
    }

    // 6. Get LLM summary
    const llmSummary = await summarizeChanges({
      websiteUrl: website.url,
      periodDays,
      oldContent: oldSnapshot.content_text,
      newContent: contentText,
      diffText,
    });

    // 7. Save completed result
    db.prepare(
      `UPDATE scan_results
       SET old_snapshot_id = ?,
           diff_summary = ?,
           llm_summary = ?,
           status = 'completed'
       WHERE id = ?`
    ).run(
      oldSnapshot.id,
      `+${addedLines} lines / -${removedLines} lines`,
      llmSummary,
      scanId
    );

    return {
      scanId,
      websiteId: website.id,
      url: website.url,
      status: 'completed',
      llmSummary,
      diffSummary: `+${addedLines} lines / -${removedLines} lines`,
      source,
    };
  } catch (err) {
    console.error(`Scan failed for ${website.url}:`, err.message);

    db.prepare(
      `UPDATE scan_results
       SET status = 'error', error_message = ?
       WHERE id = ?`
    ).run(err.message, scanId);

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
