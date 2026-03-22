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
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert sheet to JSON — first row treated as headers
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'The spreadsheet appears to be empty' });
    }

    // Flexible header detection (case-insensitive)
    const firstRow = rows[0];
    const headers = Object.keys(firstRow);

    const urlKey = headers.find((h) => /^url$/i.test(h.trim()));
    const nameKey = headers.find((h) => /^name$/i.test(h.trim()));

    if (!urlKey) {
      return res.status(400).json({
        error: `Could not find a "URL" column. Found headers: ${headers.join(', ')}`,
      });
    }

    const websites = rows
      .map((row) => ({
        url: String(row[urlKey] || '').trim(),
        name: nameKey ? String(row[nameKey] || '').trim() : '',
      }))
      .filter((w) => {
        if (!w.url) return false;
        // Basic URL validation
        try {
          new URL(w.url);
          return true;
        } catch {
          return false;
        }
      });

    if (websites.length === 0) {
      return res.status(400).json({
        error: 'No valid URLs found in the file. Ensure URLs include the protocol (https://...)',
      });
    }

    res.json({
      count: websites.length,
      websites,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to parse file: ${err.message}` });
  }
});

module.exports = router;
