/**
 * Spreadsheet import and export.
 *
 * The importer had no test at all, and it is the path that carries the real
 * monitoring list in — including from legacy .xls files. These tests pin what
 * it produces, so swapping or upgrading the spreadsheet library is checked
 * against behaviour rather than assumed.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const XLSX = require('xlsx');

const { createTestApp, signIn, as } = require('./helpers');

const SRMS_FILE = path.join(__dirname, '..', '..', 'SRMS_Compliance_FY25_SingleChar_Domain_Owner.xlsx');

let ctx;
let token;

beforeAll(async () => {
  ctx = createTestApp();
  token = (await signIn(request, ctx.app)).token;
});

afterAll(() => ctx.cleanup());

function upload(buffer, filename) {
  return as(request(ctx.app).post('/api/upload'), token).attach('file', buffer, filename);
}

/** Collect a binary response body as a Buffer. */
function binary(res, done) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

describe('importing the real SRMS spreadsheet', () => {
  let body;

  beforeAll(async () => {
    const res = await upload(fs.readFileSync(SRMS_FILE), 'srms.xlsx');
    expect(res.status).toBe(200);
    body = res.body;
  });

  it('finds every row, with nothing skipped', () => {
    expect(body.count).toBe(47);
    expect(body.sheets).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.websites).toHaveLength(47);
  });

  it('reads every column the importer maps', () => {
    expect(body.websites[0]).toEqual({
      url: 'https://www.imda.gov.sg/regulations-and-licensing-listing/telecommunications-act-1999',
      name: 'Telecommunication Act',
      domain: 'C',
      srms_owner: 'D',
      srms: 'Telecommunication Act',
    });
    expect(body.websites.at(-1)).toEqual({
      url: 'https://sso.agc.gov.sg/Act/PDPA2012',
      name: 'Personal Data Protection Act (PDPA)',
      domain: 'D',
      srms_owner: 'C',
      srms: 'Personal Data Protection Act (PDPA)',
    });
  });

  it('produces only well-formed URLs', () => {
    for (const site of body.websites) {
      expect(() => new URL(site.url), site.url).not.toThrow();
    }
  });
});

describe('export and re-import', () => {
  it('round-trips every exported column', async () => {
    const sites = [
      { url: 'https://example.com/round-trip-a', name: 'Round A', domain: 'A', srms_owner: 'Owner A' },
      { url: 'https://example.com/round-trip-b', name: 'Round B', domain: 'B', srms_owner: 'Owner B' },
    ];
    for (const site of sites) {
      const res = await as(request(ctx.app).post('/api/websites'), token).send(site);
      expect(res.status).toBeLessThan(300);
    }

    const exported = await as(request(ctx.app).get('/api/websites/export'), token)
      .buffer(true)
      .parse(binary);
    expect(exported.status).toBe(200);
    expect(exported.body.subarray(0, 2).toString()).toBe('PK'); // a zip container, i.e. real .xlsx

    const reimported = await upload(exported.body, 'websites.xlsx');
    expect(reimported.status).toBe(200);

    for (const site of sites) {
      expect(reimported.body.websites).toContainEqual(
        expect.objectContaining({
          url: site.url,
          name: site.name,
          domain: site.domain,
          srms_owner: site.srms_owner,
        })
      );
    }
  });
});

describe('other formats', () => {
  const rows = [
    { URL: 'https://example.com/legacy-one', Name: 'Legacy One', Domain: 'L', 'SRMS Owner': 'Team L' },
    { URL: 'https://example.com/legacy-two', Name: 'Legacy Two', Domain: 'M', 'SRMS Owner': 'Team M' },
  ];

  function workbook() {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Sites');
    return book;
  }

  it('reads a legacy .xls (BIFF8) workbook', async () => {
    const xls = XLSX.write(workbook(), { type: 'buffer', bookType: 'biff8' });
    // The old binary format, not a zip: the OLE compound-file signature.
    expect(xls.subarray(0, 4).toString('hex')).toBe('d0cf11e0');

    const res = await upload(xls, 'legacy.xls');

    expect(res.status).toBe(200);
    expect(res.body.websites.map((w) => w.url)).toEqual(rows.map((r) => r.URL));
    expect(res.body.websites[1]).toMatchObject({ name: 'Legacy Two', domain: 'M', srms_owner: 'Team M' });
  });

  it('reads a CSV', async () => {
    const csv = 'URL,Name,Domain\nhttps://example.com/csv-one,CSV One,X\nhttps://example.com/csv-two,CSV Two,Y\n';

    const res = await upload(Buffer.from(csv), 'sites.csv');

    expect(res.status).toBe(200);
    expect(res.body.websites).toEqual([
      expect.objectContaining({ url: 'https://example.com/csv-one', name: 'CSV One', domain: 'X' }),
      expect.objectContaining({ url: 'https://example.com/csv-two', name: 'CSV Two', domain: 'Y' }),
    ]);
  });

  it('skips rows whose URL is not a URL, and says so', async () => {
    const csv = 'URL,Name\nhttps://example.com/good,Good\nnot a url,Bad\n,Empty\n';

    const res = await upload(Buffer.from(csv), 'mixed.csv');

    expect(res.status).toBe(200);
    expect(res.body.websites.map((w) => w.url)).toEqual(['https://example.com/good']);
    expect(res.body.skippedBadUrl).toBe(1);
  });
});
