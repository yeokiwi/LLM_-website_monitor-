/**
 * Website management.
 *
 * Every route operates on the signed-in user's own websites. There is no admin
 * gate here any more: managing websites is what a subscriber does with their
 * own tenant, and isolation is enforced by the owner-scoped queries in
 * websiteRepo rather than by a role check.
 */

const express = require('express');
const XLSX = require('xlsx');

const websiteRepo = require('../repositories/websiteRepo');
const scanRepo = require('../repositories/scanRepo');
const scheduleRepo = require('../repositories/scheduleRepo');
const { requireWebsiteQuota, requireFeature } = require('../middleware/entitlements');

const router = express.Router();

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Ids from a request body, coerced to integers and de-duplicated. */
function parseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => parseInt(x, 10)).filter(Number.isInteger))];
}

// ---------------------------------------------------------------------------
// GET /api/websites — the caller's active websites
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  res.json(websiteRepo.listActive(req.user.userId));
});

// ---------------------------------------------------------------------------
// POST /api/websites — add a website
// Body: { url, name?, domain?, srms_owner?, srms? }
// ---------------------------------------------------------------------------
router.post('/', requireWebsiteQuota(), (req, res) => {
  const { url, name, domain, srms_owner, srms } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const { website, created } = websiteRepo.create(req.user.userId, {
    url: url.trim(),
    name: name?.trim() || null,
    domain: domain?.trim() || null,
    srms_owner: srms_owner?.trim() || null,
    srms: srms?.trim() || null,
  });

  res.status(created ? 201 : 200).json(website);
});

// ---------------------------------------------------------------------------
// POST /api/websites/bulk — add many at once
// Body: { websites: [{ url, name?, domain?, srms_owner?, srms? }] }
// ---------------------------------------------------------------------------
router.post(
  '/bulk',
  requireWebsiteQuota((req) => (Array.isArray(req.body.websites) ? req.body.websites.length : 1)),
  (req, res) => {
    const { websites } = req.body;

    if (!Array.isArray(websites) || websites.length === 0) {
      return res.status(400).json({ error: 'websites array is required' });
    }

    let added = 0;
    let skipped = 0;

    for (const item of websites) {
      if (!item.url || !isValidUrl(item.url)) {
        skipped++;
        continue;
      }
      const { created } = websiteRepo.create(req.user.userId, {
        url: item.url.trim(),
        name: item.name?.trim?.() || item.name || null,
        domain: item.domain?.trim?.() || item.domain || null,
        srms_owner: item.srms_owner?.trim?.() || item.srms_owner || null,
        srms: item.srms?.trim?.() || item.srms || null,
      });
      if (created) added++;
      else skipped++;
    }

    res.json({ message: `Imported ${added} website(s), skipped ${skipped}`, added, skipped });
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/websites/:id — engine flags, name and remark
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const { use_firecrawl, use_brave, use_serper, remark, name } = req.body;

  const { changes, website } = websiteRepo.update(req.user.userId, req.params.id, {
    use_firecrawl,
    use_brave,
    use_serper,
    remark,
    name,
  });

  if (changes === 0) {
    // Either the website does not exist or it belongs to someone else — the
    // response is the same either way so ids cannot be probed.
    return websiteRepo.findById(req.user.userId, req.params.id)
      ? res.status(400).json({ error: 'No updatable fields provided' })
      : res.status(404).json({ error: 'Website not found' });
  }

  res.json(website);
});

// ---------------------------------------------------------------------------
// DELETE /api/websites/:id — soft delete
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const changes = websiteRepo.deactivate(req.user.userId, req.params.id);

  if (changes === 0) {
    return res.status(404).json({ error: 'Website not found' });
  }

  scheduleRepo.removeForWebsite(req.params.id);
  res.json({ message: 'Website removed' });
});

// ---------------------------------------------------------------------------
// POST /api/websites/bulk-delete — Body: { ids: number[] }
// ---------------------------------------------------------------------------
router.post('/bulk-delete', (req, res) => {
  const ids = parseIds(req.body.ids);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }

  const removed = websiteRepo.deactivateMany(req.user.userId, ids);
  for (const id of ids) scheduleRepo.removeForWebsite(id);

  res.json({ message: `Removed ${removed} website(s)`, removed });
});

// ---------------------------------------------------------------------------
// POST /api/websites/bulk-update — apply engine flags to many websites
// Body: { ids?: number[], updates: { use_firecrawl?, use_brave?, use_serper? } }
//
// Omitting `ids` targets all of the caller's active websites.
// ---------------------------------------------------------------------------
router.post('/bulk-update', (req, res) => {
  const { updates } = req.body;

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'updates object is required' });
  }

  const updated = websiteRepo.updateFlagsBulk(
    req.user.userId,
    parseIds(req.body.ids),
    updates
  );

  if (updated === 0 && !['use_firecrawl', 'use_brave', 'use_serper'].some((f) => f in updates)) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  res.json({ updated });
});

// ---------------------------------------------------------------------------
// GET /api/websites/export — download the caller's websites as .xlsx
//
// Declared before `GET /:id` so the literal path is not captured by the
// parameter route.
// ---------------------------------------------------------------------------
router.get('/export', requireFeature('excel_import_export', 'Spreadsheet export'), (req, res) => {
  const websites = websiteRepo.listForExport(req.user.userId);

  const rows = websites.map((w) => ({
    'Internet hyperlinks': w.url,
    Name: w.name || '',
    Domain: w.domain || '',
    'SRMS Owner': w.srms_owner || '',
    SRMS: w.srms || '',
    use_firecrawl: w.use_firecrawl ? 1 : 0,
    use_brave: w.use_brave ? 1 : 0,
    use_serper: w.use_serper ? 1 : 0,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Websites');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const filename = `websites-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// GET /api/websites/:id — one website with its recent scans
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const website = websiteRepo.findActiveById(req.user.userId, req.params.id);
  if (!website) return res.status(404).json({ error: 'Website not found' });

  const recent_scans = scanRepo.listForWebsite(req.user.userId, website.id, 10);

  res.json({ ...website, recent_scans });
});

module.exports = router;
