/**
 * Scan orchestration: which engine decides the verdict, and what a row-level
 * status means.
 *
 * Two defects are pinned here. A scan where Firecrawl found changes and Brave
 * errored used to be recorded as plain `completed`, with the failure visible
 * only as prose inside the markdown. And a search engine's result — which
 * reflects a search index, not the monitored page — could set that `completed`
 * on its own.
 *
 * The scraper and the LLM are replaced on the module objects before scanService
 * is loaded: it destructures both at require time, so the substitution has to
 * happen first.
 */

const { createTestApp, ownerId: seededOwnerId, resetModules } = require('./helpers');

let harness;
let db;
let scanService;
let scraper;
let llmService;
let ownerId;

/** Per-provider scrape behaviour for the next scan. */
let scrapeBehaviour = {};

function website(overrides = {}) {
  return {
    id: websiteId,
    owner_id: ownerId,
    url: 'https://example.com/docs',
    name: 'Example Docs',
    use_firecrawl: 1,
    use_brave: 0,
    use_serper: 0,
    ...overrides,
  };
}

let websiteId;

beforeAll(async () => {
  harness = createTestApp({
    FIRECRAWL_API_KEY: 'test-firecrawl',
    BRAVE_API_KEY: 'test-brave',
    SERPER_API_KEY: 'test-serper',
  });

  ownerId = seededOwnerId(harness.db);

  websiteId = harness.db
    .prepare(
      `INSERT INTO websites (owner_id, url, name, use_firecrawl, use_brave, use_serper)
       VALUES (?, 'https://example.com/docs', 'Example Docs', 1, 0, 0)`
    )
    .run(ownerId).lastInsertRowid;

  harness.db.close();

  // Reload the service graph with the scraper and LLM stubbed out.
  resetModules();
  scraper = require('../src/services/scraper');
  llmService = require('../src/services/llmService');

  scraper.isPdfUrl = async () => false;
  scraper.scrapeWithProvider = async (provider) => {
    const behaviour = scrapeBehaviour[provider];
    if (!behaviour) throw new Error(`no behaviour configured for ${provider}`);
    if (behaviour instanceof Error) throw behaviour;
    return { contentText: behaviour, source: provider, pages: [], notes: [] };
  };
  llmService.summarizeChanges = async () => ({
    markdown: '## Executive Summary\n\nStub report.',
    usage: { inputTokens: 10, outputTokens: 20, model: 'stub' },
  });

  db = require('../src/db');
  scanService = require('../src/services/scanService');
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  harness.cleanup();
});

/** Run a scan and return the persisted row alongside the returned result. */
async function scan(site, periodDays = 30) {
  const result = await scanService.runSingleScan(site, periodDays, 'manual');
  const row = result.scanId
    ? db.prepare('SELECT * FROM scan_results WHERE id = ?').get(result.scanId)
    : null;
  return { result, row };
}

describe('resolveProviders', () => {
  it('never selects an engine the deployment has no key for', () => {
    // Carried over from the entitlements suite: the check is about API keys,
    // not about what a plan permits.
    const original = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const { providers } = scanService.resolveProviders(
        { use_firecrawl: 1, use_brave: 1, use_serper: 0 },
        ownerId
      );

      expect(providers).not.toContain('brave');
      expect(providers).toContain('firecrawl');
    } finally {
      process.env.BRAVE_API_KEY = original;
    }
  });

  it('falls back to a direct scrape when no configured engine is available', () => {
    const keys = ['FIRECRAWL_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY'];
    const original = keys.map((k) => [k, process.env[k]]);
    keys.forEach((k) => delete process.env[k]);
    try {
      const { providers, usingFallback } = scanService.resolveProviders(
        { use_firecrawl: 1, use_brave: 1, use_serper: 1 },
        ownerId
      );

      expect(providers).toEqual(['direct']);
      expect(usingFallback).toBe(true);
    } finally {
      original.forEach(([k, v]) => { process.env[k] = v; });
    }
  });

  it('always gives a website a detector engine', () => {
    // Search engines see the index, not the page. A Brave-only website had no
    // engine actually reading what it was monitoring.
    const { providers } = scanService.resolveProviders(
      { use_firecrawl: 0, use_brave: 1, use_serper: 0 },
      ownerId
    );

    expect(providers).toContain('direct');
    expect(providers).toContain('brave');
    expect(providers.indexOf('direct')).toBeLessThan(providers.indexOf('brave'));
  });

  it('does not add a second detector when one is already configured', () => {
    const { providers } = scanService.resolveProviders(
      { use_firecrawl: 1, use_brave: 1, use_serper: 0 },
      ownerId
    );

    expect(providers).toEqual(['firecrawl', 'brave']);
  });
});

describe('status aggregation', () => {
  it('marks a scan partial when one engine fails and another succeeds', async () => {
    const site = website({ use_firecrawl: 1, use_brave: 1 });

    scrapeBehaviour = { firecrawl: 'baseline content', brave: 'brave baseline' };
    await scan(site); // establishes baselines

    scrapeBehaviour = {
      firecrawl: 'baseline content\nplus a new paragraph',
      brave: new Error('Brave web search failed: HTTP 429'),
    };
    const { result, row } = await scan(site);

    expect(result.status).toBe('partial');
    expect(row.status).toBe('partial');
    // The failure is a column, not a sentence buried in the report.
    expect(row.error_message).toMatch(/429/);
    expect(JSON.parse(row.engine_statuses)).toEqual({
      firecrawl: 'completed',
      brave: 'error',
    });
  });

  it('still reports changes found on a partial scan', async () => {
    const site = website({ id: newWebsite('https://example.com/partial-changes'), use_brave: 1 });

    scrapeBehaviour = { firecrawl: 'first', brave: 'brave first' };
    await scan(site);

    scrapeBehaviour = { firecrawl: 'first\nsecond', brave: new Error('brave down') };
    const { result } = await scan(site);

    // The scheduler keys its change alert off this rather than the status, so a
    // partial scan still notifies.
    expect(result.changesFound).toBe(true);
  });

  it('does not let a search engine alone declare the page changed', async () => {
    const site = website({ id: newWebsite('https://example.com/search-noise'), use_brave: 1 });

    scrapeBehaviour = { firecrawl: 'unchanged page', brave: 'brave results v1' };
    await scan(site);

    // The page is untouched; only the search index moved.
    scrapeBehaviour = { firecrawl: 'unchanged page', brave: 'brave results v2 with a new hit' };
    const { result } = await scan(site);

    expect(result.status).toBe('no_changes');
    expect(result.changesFound).toBe(false);
  });

  it('reports error and writes no row when every engine fails', async () => {
    const site = website({ id: newWebsite('https://example.com/all-down') });

    scrapeBehaviour = { firecrawl: new Error('Firecrawl returned no content') };
    const { result } = await scan(site);

    expect(result.status).toBe('error');
    expect(result.scanId).toBeNull();

    // Nothing usable was produced, so nothing was snapshotted — the baseline
    // stays clean instead of holding a failure message.
    const snapshots = db
      .prepare('SELECT COUNT(*) AS n FROM snapshots WHERE website_id = ?')
      .get(site.id);
    expect(snapshots.n).toBe(0);
  });

  it('reports no_history on the first scan and compares on the second', async () => {
    const site = website({ id: newWebsite('https://example.com/history') });

    scrapeBehaviour = { firecrawl: 'version one' };
    const first = await scan(site);
    expect(first.result.status).toBe('no_history');

    // The bug this replaces: with the old baseline query every subsequent scan
    // also returned no_history, forever.
    scrapeBehaviour = { firecrawl: 'version two' };
    const second = await scan(site);
    expect(second.result.status).toBe('completed');
    expect(second.row.old_snapshot_id).not.toBeNull();
  });

  it('reports no_changes when the content is unchanged', async () => {
    const site = website({ id: newWebsite('https://example.com/stable') });

    scrapeBehaviour = { firecrawl: 'stable content' };
    await scan(site);
    const { result } = await scan(site);

    expect(result.status).toBe('no_changes');
  });
});

/** Insert an extra website owned by the test account. */
function newWebsite(url) {
  return db
    .prepare(
      `INSERT INTO websites (owner_id, url, name, use_firecrawl, use_brave, use_serper)
       VALUES (?, ?, ?, 1, 0, 0)`
    )
    .run(ownerId, url, url).lastInsertRowid;
}
