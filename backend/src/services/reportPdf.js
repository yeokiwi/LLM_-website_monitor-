/**
 * Report PDF builder
 *
 * Renders one or more scan results — each an LLM-produced structured markdown
 * change report — into a single, multi-section PDF document.
 *
 * The generator understands the subset of markdown the reports use:
 *   #/##/### headings, `-`/`*` bullet lists, **bold** inline spans,
 *   `---` horizontal rules, blockquotes and plain paragraphs. Links and inline
 *   code are flattened to their visible text. Anything else is treated as a
 *   paragraph, so unexpected content still renders (just without styling).
 */

const PDFDocument = require('pdfkit');

const COLORS = {
  heading: '#111827',
  subheading: '#1f2937',
  text: '#374151',
  muted: '#6b7280',
  accent: '#2563eb',
  rule: '#e5e7eb',
};

const STATUS_LABELS = {
  completed: 'Changes Found',
  no_changes: 'No Changes',
  no_history: 'Initial Report',
  error: 'Error',
};

// ---------------------------------------------------------------------------
// Inline markdown → styled runs
// ---------------------------------------------------------------------------

/** Parse a single line into [{ text, bold }] runs, flattening links/code. */
function parseInline(text) {
  const clean = String(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → visible text
    .replace(/`([^`]+)`/g, '$1'); // inline code → text

  const parts = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) parts.push({ text: clean.slice(last, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < clean.length) parts.push({ text: clean.slice(last), bold: false });
  if (parts.length === 0) parts.push({ text: clean, bold: false });
  return parts;
}

/** Write inline runs on a single wrapped line, toggling bold as needed. */
function writeInline(doc, parts, { size, color, indent = 0 }) {
  parts.forEach((p, i) => {
    const isLast = i === parts.length - 1;
    doc
      .font(p.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(size)
      .fillColor(color)
      .text(p.text, { continued: !isLast, indent });
  });
}

// ---------------------------------------------------------------------------
// Markdown body renderer
// ---------------------------------------------------------------------------

function renderMarkdown(doc, markdown) {
  const lines = String(markdown).split('\n');

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    // Blank line → vertical gap
    if (line.trim() === '') {
      doc.moveDown(0.4);
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      doc.moveDown(0.2);
      const y = doc.y;
      doc
        .strokeColor(COLORS.rule)
        .lineWidth(1)
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .stroke();
      doc.moveDown(0.5);
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const size = level === 1 ? 16 : level === 2 ? 13 : 11.5;
      doc.moveDown(level === 1 ? 0.6 : 0.4);
      doc
        .font('Helvetica-Bold')
        .fontSize(size)
        .fillColor(level === 1 ? COLORS.heading : COLORS.subheading)
        .text(h[2].trim());
      doc.moveDown(0.2);
      continue;
    }

    // Blockquote
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) {
      writeInline(doc, parseInline(bq[1]), { size: 10.5, color: COLORS.muted, indent: 14 });
      continue;
    }

    // Bullet list item
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const indent = 12 + depth * 14;
      const parts = parseInline(bullet[2]);
      // Prepend the bullet marker to the first run.
      parts[0] = { ...parts[0], text: `•  ${parts[0].text}` };
      writeInline(doc, parts, { size: 11, color: COLORS.text, indent });
      continue;
    }

    // Plain paragraph
    writeInline(doc, parseInline(line), { size: 11, color: COLORS.text });
  }
}

// ---------------------------------------------------------------------------
// Per-scan report section
// ---------------------------------------------------------------------------

function renderScanSection(doc, scan) {
  const siteName = scan.name || scan.url || 'Untitled site';
  const statusLabel = STATUS_LABELS[scan.status] || scan.status || '';

  // Section title
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(COLORS.heading)
    .text(siteName);

  if (scan.name && scan.url) {
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.accent).text(scan.url);
  }

  // Meta line
  const metaBits = [];
  if (statusLabel) metaBits.push(statusLabel);
  if (scan.period_days) metaBits.push(`${scan.period_days}-day period`);
  if (scan.diff_summary) metaBits.push(scan.diff_summary);
  if (scan.scanned_at) metaBits.push(new Date(scan.scanned_at).toLocaleString());
  const ownerBits = [];
  if (scan.domain) ownerBits.push(`Domain: ${scan.domain}`);
  if (scan.srms_owner) ownerBits.push(`Owner: ${scan.srms_owner}`);
  if (scan.srms) ownerBits.push(`SRMS: ${scan.srms}`);

  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.muted).text(metaBits.join('   •   '));
  if (ownerBits.length) {
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.muted).text(ownerBits.join('   •   '));
  }

  // Divider under the header
  doc.moveDown(0.4);
  const y = doc.y;
  doc
    .strokeColor(COLORS.rule)
    .lineWidth(1)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke();
  doc.moveDown(0.6);

  // Body
  if (scan.llm_summary) {
    renderMarkdown(doc, scan.llm_summary);
  } else if (scan.status === 'no_changes') {
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor(COLORS.text)
      .text('No changes detected during this period.');
  } else if (scan.status === 'error') {
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor(COLORS.text)
      .text(`Scan error: ${scan.error_message || 'Unknown error'}`);
  } else {
    doc.font('Helvetica').fontSize(11).fillColor(COLORS.muted).text('No report available.');
  }

  // User remark, if any
  if (scan.remark) {
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.subheading).text('Remark');
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text).text(scan.remark);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a single PDF containing every provided scan report.
 * @param {Array<object>} scans — scan_results joined with website metadata
 * @returns {Promise<Buffer>}
 */
function buildReportsPdf(scans) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Cover header
    doc
      .font('Helvetica-Bold')
      .fontSize(24)
      .fillColor(COLORS.heading)
      .text('Website Monitor — Scan Reports');
    doc.moveDown(0.3);
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor(COLORS.muted)
      .text(`Generated ${new Date().toLocaleString()}`);
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor(COLORS.muted)
      .text(`${scans.length} report${scans.length === 1 ? '' : 's'} included`);

    scans.forEach((scan, i) => {
      // Each report starts on its own page (the cover shares page 1 with the
      // first report only if there is exactly one; otherwise give each a page).
      if (i === 0) doc.moveDown(1.2);
      else doc.addPage();
      renderScanSection(doc, scan);
    });

    if (scans.length === 0) {
      doc.moveDown(1.2);
      doc
        .font('Helvetica')
        .fontSize(12)
        .fillColor(COLORS.text)
        .text('No scan reports are available to export yet.');
    }

    // Page numbers in the footer
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 35;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.margins.left, bottom, {
          align: 'center',
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          lineBreak: false,
        });
    }

    doc.end();
  });
}

module.exports = { buildReportsPdf };
