/**
 * PDF monitoring: what counts as the document, and what it is compared with.
 *
 * Pins a false "document deleted" report. A site behind bot protection answered
 * the monitor's download with HTTP 200 and an HTML or empty body. That was
 * snapshotted as an unreadable PDF, and diffing it against the previous scan's
 * text read as the whole handbook being removed. The next good scan then diffed
 * the text against that placeholder and read as the whole handbook being added.
 *
 * Downloads are faked by swapping axios's adapter, as in scraper.test.js. The
 * scan-level tests replace scrapePdf on the module object before scanService
 * is loaded, because scanService destructures it at require time.
 */

const axios = require('axios');
const PDFDocument = require('pdfkit');
const { createTestApp, ownerId: seededOwnerId, resetModules } = require('./helpers');

const PDF_URL = 'https://example.gov/files/handbook.pdf';

const realAdapter = axios.defaults.adapter;

/** Answer every request with `{ status, data, headers }` from `handler`. */
function route(handler) {
  axios.defaults.adapter = async (config) => {
    const { status = 200, data, headers = {} } = await handler(config);
    const response = { data, status, statusText: 'OK', headers, config };
    const accepted = config.validateStatus
      ? config.validateStatus(status)
      : status >= 200 && status < 300;
    if (accepted) return response;

    const err = new Error(`Request failed with status code ${status}`);
    err.isAxiosError = true;
    err.response = response;
    throw err;
  };
}

/** A small, real PDF holding `lines` as text. */
function makePdf(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

let harness;
let db;
let scraper;
let scanService;
let snapshotService;
let realScrapePdf;
let ownerId;

/** What the stubbed scrapePdf returns (or throws) on the next scan. */
let nextPdfContent;

beforeAll(() => {
  harness = createTestApp();
  ownerId = seededOwnerId(harness.db);
  harness.db.close();

  resetModules();
  scraper = require('../src/services/scraper');
  const llmService = require('../src/services/llmService');

  realScrapePdf = scraper.scrapePdf;
  scraper.isPdfUrl = async () => true;
  scraper.scrapePdf = async (url) => {
    if (nextPdfContent instanceof Error) throw nextPdfContent;
    return { contentText: nextPdfContent, source: 'pdf', pages: [{ type: 'pdf', url }] };
  };
  llmService.summarizeChanges = async () => ({
    markdown: '## Executive Summary\n\nStub report.',
    usage: { inputTokens: 10, outputTokens: 20, model: 'stub' },
  });

  db = require('../src/db');
  scanService = require('../src/services/scanService');
  snapshotService = require('../src/services/snapshotService');
});

afterEach(() => {
  axios.defaults.adapter = realAdapter;
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  harness.cleanup();
});

describe('downloading a PDF', () => {
  it('extracts the text of a real PDF', async () => {
    const pdf = await makePdf(['Spectrum Management Handbook', 'Section 1: Licensing']);
    route(() => ({ data: pdf, headers: { 'content-type': 'application/pdf' } }));

    const { contentText } = await realScrapePdf(PDF_URL);

    expect(contentText).toContain('Spectrum Management Handbook');
    expect(contentText).toContain('Section 1: Licensing');
    expect(scraper.isPdfFingerprintOnly(contentText)).toBe(false);
  });

  it('rejects an HTML page served in place of the PDF', async () => {
    route(() => ({
      data: Buffer.from('<html><head><title>Access Denied</title></head><body>Blocked</body></html>'),
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));

    await expect(realScrapePdf(PDF_URL)).rejects.toMatchObject({
      name: 'ScrapeError',
      message: expect.stringMatching(/text\/html.*"Access Denied".*instead of a PDF/),
    });
  });

  it('rejects an empty response', async () => {
    route(() => ({ data: Buffer.alloc(0), headers: { 'content-type': 'application/pdf' } }));

    await expect(realScrapePdf(PDF_URL)).rejects.toMatchObject({
      name: 'ScrapeError',
      message: expect.stringContaining('empty response'),
    });
  });

  it('reports an HTTP failure with its status', async () => {
    route(() => ({ status: 403, data: Buffer.from('Forbidden') }));

    await expect(realScrapePdf(PDF_URL)).rejects.toMatchObject({
      name: 'ScrapeError',
      message: expect.stringContaining('HTTP 403'),
    });
  });

  it('still fingerprints a real PDF whose text cannot be read', async () => {
    route(() => ({ data: Buffer.from('%PDF-1.4\nnot a parseable body'), headers: {} }));

    const { contentText } = await realScrapePdf(PDF_URL);

    expect(scraper.isPdfFingerprintOnly(contentText)).toBe(true);
    expect(contentText).toContain('Content fingerprint:');
  });
});

describe('comparing PDF scans', () => {
  const TEXT = `PDF document: ${PDF_URL}\n\nSpectrum Management Handbook\nSection 1: Licensing`;
  const FINGERPRINT =
    `PDF document: ${PDF_URL}\n\n[PDF text could not be extracted: Invalid PDF structure]\n` +
    'Bytes: 0\nContent fingerprint: e3b0c44298fc1c149afbf4c8996fb924';

  let sites = 0;

  /** A fresh website, so each test starts with no snapshots. */
  function newWebsite() {
    sites += 1;
    const url = `${PDF_URL}?copy=${sites}`;
    const id = db
      .prepare(`INSERT INTO websites (owner_id, url, name) VALUES (?, ?, 'Handbook')`)
      .run(ownerId, url).lastInsertRowid;
    return { id, owner_id: ownerId, url, name: 'Handbook' };
  }

  function snapshotCount(websiteId) {
    return db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE website_id = ?').get(websiteId).n;
  }

  async function scan(site, content) {
    nextPdfContent = content;
    return scanService.runSingleScan(site, 30, 'manual');
  }

  it('fails a blocked download without saving a snapshot', async () => {
    const site = newWebsite();
    await scan(site, TEXT);

    const blocked = new scraper.ScrapeError('returned text/html instead of a PDF', { provider: 'pdf' });
    const result = await scan(site, blocked);

    expect(result.status).toBe('error');
    expect(snapshotCount(site.id)).toBe(1);
  });

  it('does not report the document deleted when its text stops being readable', async () => {
    const site = newWebsite();
    await scan(site, TEXT);

    const result = await scan(site, FINGERPRINT);

    expect(result.status).toBe('error');
    expect(result.error).toContain('could not be read');
    expect(snapshotCount(site.id)).toBe(1);

    // The next readable scan still compares against the last text.
    expect((await scan(site, TEXT)).status).toBe('no_changes');
  });

  it('skips a placeholder an earlier build saved when picking the baseline', async () => {
    const site = newWebsite();
    await scan(site, TEXT);
    snapshotService.saveSnapshot(site.id, FINGERPRINT, 'pdf');

    expect((await scan(site, TEXT)).status).toBe('no_changes');
  });

  it('treats the first readable scan after only placeholders as a first scan', async () => {
    const site = newWebsite();
    snapshotService.saveSnapshot(site.id, FINGERPRINT, 'pdf');

    expect((await scan(site, TEXT)).status).toBe('no_history');
  });

  it('keeps comparing fingerprints for a PDF that has never been readable', async () => {
    const site = newWebsite();
    await scan(site, FINGERPRINT);

    expect((await scan(site, FINGERPRINT)).status).toBe('no_changes');
    expect((await scan(site, FINGERPRINT.replace('e3b0', 'ffff'))).status).toBe('completed');
  });

  it('still reports a real change in the text', async () => {
    const site = newWebsite();
    await scan(site, TEXT);

    const result = await scan(site, `${TEXT}\nSection 2: New spectrum fees`);

    expect(result.status).toBe('completed');
    expect(result.diff_summary).toContain('+1');
  });
});
