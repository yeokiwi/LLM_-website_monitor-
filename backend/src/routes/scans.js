/**
 * Scan results and scan triggering.
 *
 * Every read is scoped to the signed-in user through scanRepo. The scan logic
 * itself lives in services/scanService so the scheduler runs the identical
 * path.
 */

const express = require('express');

const scanRepo = require('../repositories/scanRepo');
const websiteRepo = require('../repositories/websiteRepo');
const { buildReportsPdf } = require('../services/reportPdf');
const { runSingleScan } = require('../services/scanService');
const { requireFeature, requireScanQuota } = require('../middleware/entitlements');

const router = express.Router();

function parseIdList(value) {
  return String(value || '')
    .split(',')
    .map((x) => parseInt(x, 10))
    .filter(Number.isInteger);
}

// ---------------------------------------------------------------------------
// GET /api/scans/export-pdf — export the caller's scan reports as one PDF
//
// `?ids=1,2,3` narrows to a subset; the intersection with owned scans happens
// in SQL, so a crafted id list cannot reach another tenant's report.
//
// NOTE: must be declared before `GET /:id` so the literal path is not captured
// by the `:id` parameter route.
// ---------------------------------------------------------------------------
router.get('/export-pdf', requireFeature('pdf_export', 'PDF export'), async (req, res) => {
  const idsParam = (req.query.ids || '').trim();
  const ids = idsParam ? parseIdList(idsParam) : null;

  if (idsParam && ids.length === 0) {
    return res.status(400).json({ error: 'No valid scan ids provided' });
  }

  const scans = scanRepo.listForExport(req.user.userId, ids);

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
// GET /api/scans — the caller's scan results (paginated)
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  const { total, results } = scanRepo.list(req.user.userId, limit, offset);
  res.json({ total, limit, offset, results });
});

// ---------------------------------------------------------------------------
// GET /api/scans/:id
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const scan = scanRepo.findById(req.user.userId, req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

// ---------------------------------------------------------------------------
// GET /api/scans/website/:websiteId
// ---------------------------------------------------------------------------
router.get('/website/:websiteId', (req, res) => {
  res.json(scanRepo.listForWebsite(req.user.userId, req.params.websiteId));
});

// ---------------------------------------------------------------------------
// PATCH /api/scans/:id — save a remark on a scan result
// Body: { remark: string }
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const { remark } = req.body;
  if (remark === undefined) {
    return res.status(400).json({ error: 'remark is required' });
  }

  const scan = scanRepo.updateRemark(req.user.userId, req.params.id, remark);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  res.json(scan);
});

// ---------------------------------------------------------------------------
// POST /api/scans — trigger a scan
// Body: { websiteIds: number[], periodDays: number }
//
// The whole batch is checked against the remaining scan allowance before any
// work starts, so the request either runs in full or is rejected with a 402.
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireScanQuota((req) =>
    Array.isArray(req.body.websiteIds) ? req.body.websiteIds.length : 1
  ),
  async (req, res) => {
    const { websiteIds, periodDays } = req.body;

    if (!Array.isArray(websiteIds) || websiteIds.length === 0) {
      return res.status(400).json({ error: 'websiteIds must be a non-empty array' });
    }

    const period = parseInt(periodDays, 10) || 30;
    if (period < 1 || period > 3650) {
      return res.status(400).json({ error: 'periodDays must be between 1 and 3650' });
    }

    const websites = websiteRepo.findActiveByIds(req.user.userId, websiteIds);

    if (websites.length === 0) {
      return res.status(404).json({ error: 'No active websites found for the given IDs' });
    }

    // Run scans sequentially to respect LLM rate limits
    const results = [];
    for (const website of websites) {
      results.push(await runSingleScan(website, period, 'manual'));
    }

    res.json({ scanned: results.length, results });
  }
);

module.exports = router;
