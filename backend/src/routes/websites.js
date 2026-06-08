const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/websites — list all active websites
router.get('/', (req, res) => {
  const websites = db
    .prepare(
      `
      SELECT w.*,
             (SELECT scraped_at FROM snapshots WHERE website_id = w.id ORDER BY scraped_at DESC LIMIT 1)
               AS last_scanned_at,
             (SELECT COUNT(*) FROM snapshots WHERE website_id = w.id)
               AS snapshot_count
      FROM websites w
      WHERE w.is_active = 1
      ORDER BY w.created_at DESC
    `
    )
    .all();
  res.json(websites);
});

// POST /api/websites — add a single website
router.post('/', (req, res) => {
  const { url, name, domain, srms_owner, srms } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  try {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO websites (url, name, domain, srms_owner, srms) VALUES (?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      url.trim(),
      name?.trim() || null,
      domain?.trim() || null,
      srms_owner?.trim() || null,
      srms?.trim() || null,
    );

    if (result.changes === 0) {
      // URL already exists — fetch and return it
      const existing = db.prepare('SELECT * FROM websites WHERE url = ?').get(url.trim());
      return res.status(200).json(existing);
    }

    const website = db
      .prepare('SELECT * FROM websites WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json(website);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/websites/bulk — add multiple websites at once
router.post('/bulk', (req, res) => {
  const { websites } = req.body;

  if (!Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'websites array is required' });
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO websites (url, name, domain, srms_owner, srms) VALUES (?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((items) => {
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      if (!item.url) continue;
      try {
        new URL(item.url);
      } catch {
        skipped++;
        continue;
      }
      const result = insert.run(
        item.url.trim(),
        item.name?.trim() || null,
        item.domain?.trim?.() || item.domain || null,
        item.srms_owner?.trim?.() || item.srms_owner || null,
        item.srms?.trim?.() || item.srms || null,
      );
      if (result.changes > 0) added++;
      else skipped++;
    }
    return { added, skipped };
  });

  const stats = insertMany(websites);
  res.json({ message: `Imported ${stats.added} website(s), skipped ${stats.skipped}`, ...stats });
});

// PATCH /api/websites/:id — update per-website scraper engine flags
// Body: { use_firecrawl?: 0|1|boolean, use_brave?: 0|1|boolean }
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const { use_firecrawl, use_brave } = req.body;

  const updates = [];
  const values = [];
  if (use_firecrawl !== undefined) {
    updates.push('use_firecrawl = ?');
    values.push(use_firecrawl ? 1 : 0);
  }
  if (use_brave !== undefined) {
    updates.push('use_brave = ?');
    values.push(use_brave ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  values.push(id);
  const result = db
    .prepare(`UPDATE websites SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Website not found' });
  }

  const website = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  res.json(website);
});

// DELETE /api/websites/:id — soft-delete (deactivate) a website
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const result = db
    .prepare('UPDATE websites SET is_active = 0 WHERE id = ?')
    .run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Website not found' });
  }
  res.json({ message: 'Website removed' });
});

// POST /api/websites/bulk-delete — soft-delete many websites at once
// Body: { ids: number[] }
router.post('/bulk-delete', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const result = db
    .prepare(`UPDATE websites SET is_active = 0 WHERE id IN (${placeholders})`)
    .run(...ids);
  res.json({ message: `Removed ${result.changes} website(s)`, removed: result.changes });
});

// GET /api/websites/:id — get a single website with its recent scans
router.get('/:id', (req, res) => {
  const website = db
    .prepare('SELECT * FROM websites WHERE id = ? AND is_active = 1')
    .get(req.params.id);

  if (!website) return res.status(404).json({ error: 'Website not found' });

  const scans = db
    .prepare(
      `SELECT * FROM scan_results WHERE website_id = ? ORDER BY scanned_at DESC LIMIT 10`
    )
    .all(req.params.id);

  res.json({ ...website, recent_scans: scans });
});

module.exports = router;
