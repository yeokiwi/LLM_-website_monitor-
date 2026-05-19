const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');

const router = express.Router();

// Store file in memory (no disk write)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
    ];
    if (
      allowed.includes(file.mimetype) ||
      file.originalname.match(/\.(xlsx|xls|csv)$/i)
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls) and CSV files are accepted'));
    }
  },
});

/**
 * POST /api/upload
 * Accepts an Excel file and returns a parsed list of { url, name } objects.
 * The caller is responsible for inserting them via POST /api/websites/bulk.
 */
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return res.status(400).json({ error: 'The spreadsheet appears to be empty' });
    }

    const allHeadersSeen = new Set();
    const websites = [];
    let skippedNoUrl = 0;
    let skippedBadUrl = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length === 0) continue;

      const headers = Object.keys(rows[0]);
      headers.forEach((h) => allHeadersSeen.add(h));

      const findKey = (pattern) => headers.find((h) => pattern.test(h.trim()));
      const urlKey    = findKey(/^url$/i) || findKey(/^internet\s*hyperlinks?$/i);
      const nameKey   = findKey(/^name$/i);
      const domainKey = findKey(/^domain$/i);
      const ownerKey  = findKey(/^srms\s*owner$/i);
      const srmsKey   = findKey(/^srms$/i);

      // A sheet without the URL column is silently skipped — other sheets
      // in a multi-sheet workbook may still contain valid data.
      if (!urlKey) continue;

      for (const row of rows) {
        const url    = String(row[urlKey]   || '').trim();
        const name   = nameKey   ? String(row[nameKey]   || '').trim() : '';
        const domain = domainKey ? String(row[domainKey] || '').trim() : '';
        const owner  = ownerKey  ? String(row[ownerKey]  || '').trim() : '';
        const srms   = srmsKey   ? String(row[srmsKey]   || '').trim() : '';

        // Skip rows with no Internet hyperlinks content
        if (!url) {
          skippedNoUrl++;
          continue;
        }
        // Basic URL validation
        try {
          new URL(url);
        } catch {
          skippedBadUrl++;
          continue;
        }

        websites.push({
          url,
          // Fall back to the SRMS title when no Name column is present
          name: name || srms || '',
          domain: domain || null,
          srms_owner: owner || null,
          srms: srms || null,
        });
      }
    }

    if (websites.length === 0) {
      const headersList = Array.from(allHeadersSeen).join(', ') || '(none)';
      return res.status(400).json({
        error: `No valid URLs found in the file. Looked across ${workbook.SheetNames.length} sheet(s); headers seen: ${headersList}`,
      });
    }

    res.json({
      count: websites.length,
      skipped: skippedNoUrl + skippedBadUrl,
      skippedNoUrl,
      skippedBadUrl,
      sheets: workbook.SheetNames.length,
      websites,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to parse file: ${err.message}` });
  }
});

module.exports = router;
