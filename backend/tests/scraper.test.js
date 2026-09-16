/**
 * Scraper normalisation and failure handling.
 *
 * Two classes of bug live here, and both corrupt reports rather than breaking
 * them:
 *
 *   - search results that are unstable between identical calls, so an unchanged
 *     page produces a diff, an LLM call, and a "Changes Found" verdict;
 *   - failures returned as content, so the failure message gets snapshotted and
 *     diffs against the real page when the site recovers.
 *
 * Providers are faked by swapping axios's adapter rather than by mocking the
 * module. The scraper holds its own `require('axios')`, and this way the real
 * axios still applies its own status handling — an HTTP 429 arrives at the
 * scraper as the AxiosError it would see in production.
 */

const axios = require('axios');
const { scrapeWithProvider, ScrapeError } = require('../src/services/scraper');
const { computeDiff } = require('../src/services/diffService');

const realAdapter = axios.defaults.adapter;

/**
 * Route every request through `handler(config)`, which returns `{ status, data }`
 * or throws to simulate a transport-level failure.
 */
function route(handler) {
  axios.defaults.adapter = async (config) => {
    const { status = 200, data } = await handler(config);
    const response = { data, status, statusText: 'OK', headers: {}, config };

    // A custom adapter owns status handling, so reject exactly as axios's own
    // adapters do — otherwise a 429 would arrive at the scraper as a success.
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

/** The search query, wherever the provider puts it (Brave: params, Serper: body). */
function queryOf(config) {
  if (config.params?.q) return config.params.q;
  try {
    return JSON.parse(config.data || '{}').q || '';
  } catch {
    return '';
  }
}

const isNewsCall = (config) => config.url.includes('/news');
const isAnnouncementCall = (config) => /announcement/.test(queryOf(config));

function braveWebResult(url, title, age) {
  return { url, title, description: `About ${title}`, age };
}

/** Route Brave's three searches: web, news, announcements. */
function mockBrave({ web = [], news = [], announcements = [] } = {}) {
  route((config) => {
    if (isNewsCall(config)) return { data: { results: news } };
    return { data: { web: { results: isAnnouncementCall(config) ? announcements : web } } };
  });
}

/** Route Serper's three searches. */
function mockSerper({ organic = [], news = [], announcements = [] } = {}) {
  route((config) => {
    if (isNewsCall(config)) return { data: { news } };
    return { data: { organic: isAnnouncementCall(config) ? announcements : organic } };
  });
}

beforeEach(() => {
  process.env.BRAVE_API_KEY = 'test-brave-key';
  process.env.SERPER_API_KEY = 'test-serper-key';
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
});

afterEach(() => {
  axios.defaults.adapter = realAdapter;
});

describe('Brave search normalisation', () => {
  it('produces identical content for the same results reordered with different ages', async () => {
    // This is the bug that made nearly every search-engine scan report changes:
    // result order varies between calls and `age` is a relative string that
    // shifts by the day, so the hashed body was never twice the same.
    mockBrave({
      web: [
        braveWebResult('https://example.com/a', 'Page A', '2 days ago'),
        braveWebResult('https://example.com/b', 'Page B', '1 week ago'),
        braveWebResult('https://example.com/c', 'Page C', '3 days ago'),
      ],
    });
    const first = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    mockBrave({
      web: [
        braveWebResult('https://example.com/c', 'Page C', '5 days ago'),
        braveWebResult('https://example.com/a', 'Page A', '4 days ago'),
        braveWebResult('https://example.com/b', 'Page B', '2 weeks ago'),
      ],
    });
    const second = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    expect(second.contentText).toBe(first.contentText);
    expect(first.contentText).not.toMatch(/ago/);
    expect(computeDiff(first.contentText, second.contentText).hasChanges).toBe(false);
  });

  it('records a genuinely new page as an added line', async () => {
    mockBrave({ web: [braveWebResult('https://example.com/a', 'Page A', '2 days ago')] });
    const before = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    mockBrave({
      web: [
        braveWebResult('https://example.com/new', 'Brand New Page', '1 day ago'),
        braveWebResult('https://example.com/a', 'Page A', '9 days ago'),
      ],
    });
    const after = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    const { hasChanges, diffText } = computeDiff(before.contentText, after.contentText);

    expect(hasChanges).toBe(true);
    expect(diffText).toContain('+ https://example.com/new');
    // The unchanged page is not reported as changed alongside it.
    expect(diffText).not.toContain('- https://example.com/a');
  });

  it('keeps absolute publication dates but drops relative ages', async () => {
    mockBrave({
      web: [
        {
          url: 'https://example.com/dated',
          title: 'Dated',
          description: '',
          page_age: '2026-03-01T10:00:00Z',
        },
        braveWebResult('https://example.com/relative', 'Relative', '3 days ago'),
      ],
    });
    const { contentText, pages } = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    expect(contentText).toContain('2026-03-01');
    expect(contentText).not.toContain('3 days ago');
    // The relative age survives on the page objects, which are not hashed and
    // are still shown to the LLM as a recency signal.
    expect(pages.find((p) => p.url.endsWith('/relative')).published).toBe('3 days ago');
  });

  it('scopes the search to the monitored page, not the whole domain', async () => {
    const queries = [];
    route((config) => {
      queries.push(queryOf(config));
      return isNewsCall(config) ? { data: { results: [] } } : { data: { web: { results: [] } } };
    });

    await scrapeWithProvider('brave', 'https://sso.agc.gov.sg/Act/WSHA2006', 30);

    // 21 Acts share sso.agc.gov.sg; a domain-wide query gave them all the same
    // results, so each reported on whatever AGC indexed most recently.
    expect(queries[0]).toContain('inurl:/Act/WSHA2006');
    expect(queries[0]).not.toBe('site:sso.agc.gov.sg');
  });

  it('still monitors the whole domain when the URL is a bare domain', async () => {
    const queries = [];
    route((config) => {
      queries.push(queryOf(config));
      return isNewsCall(config) ? { data: { results: [] } } : { data: { web: { results: [] } } };
    });

    await scrapeWithProvider('brave', 'https://example.com', 30);

    expect(queries[0]).toBe('site:example.com');
  });

  it('throws when the primary search fails instead of snapshotting an empty result', async () => {
    // An exhausted quota used to be swallowed by Promise.allSettled and stored
    // as "No indexed content found for …", which then diffed as a full removal.
    route((config) => {
      if (isNewsCall(config)) return { data: { results: [] } };
      if (isAnnouncementCall(config)) return { data: { web: { results: [] } } };
      return { status: 429, data: { message: 'Rate limit exceeded' } };
    });

    const attempt = () => scrapeWithProvider('brave', 'https://example.com/docs', 30);
    await expect(attempt()).rejects.toThrow(ScrapeError);
    await expect(attempt()).rejects.toThrow(/429/);
  });

  it('treats a successful search with no hits as a real empty result', async () => {
    // Zero results for a page-scoped query is a legitimate state, not a failure.
    mockBrave({});
    const { contentText } = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    expect(contentText).toContain('Results (0):');
  });

  it('notes a failed secondary search without failing the scrape', async () => {
    route((config) => {
      if (isNewsCall(config)) return { status: 503, data: 'upstream down' };
      if (isAnnouncementCall(config)) return { data: { web: { results: [] } } };
      return {
        data: { web: { results: [braveWebResult('https://example.com/a', 'Page A', '1 day ago')] } },
      };
    });

    const { contentText, notes } = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    expect(notes.join(' ')).toMatch(/news search unavailable/i);
    // The note must not reach the hashed body, or it becomes a diff of its own.
    expect(contentText).not.toMatch(/unavailable/i);
  });

  it('deduplicates a page returned by more than one search', async () => {
    const result = braveWebResult('https://example.com/a', 'Page A', '1 day ago');
    mockBrave({ web: [result], announcements: [result] });

    const { contentText } = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    expect(contentText).toContain('Results (1):');
  });
});

describe('Serper search normalisation', () => {
  const organic = [
    { link: 'https://example.com/b', title: 'B', snippet: 'b', date: '2 days ago' },
    { link: 'https://example.com/a', title: 'A', snippet: 'a', date: '1 week ago' },
  ];

  it('is order-stable and drops relative dates', async () => {
    mockSerper({ organic });
    const first = await scrapeWithProvider('serper', 'https://example.com/docs', 30);

    mockSerper({ organic: [...organic].reverse() });
    const second = await scrapeWithProvider('serper', 'https://example.com/docs', 30);

    expect(second.contentText).toBe(first.contentText);
    expect(first.contentText).not.toMatch(/ago/);
  });

  it('throws when the primary search fails', async () => {
    route((config) => {
      if (isNewsCall(config)) return { data: { news: [] } };
      return { status: 403, data: { message: 'Quota exhausted' } };
    });

    await expect(scrapeWithProvider('serper', 'https://example.com/docs', 30)).rejects.toThrow(
      ScrapeError
    );
  });
});

describe('Firecrawl', () => {
  it('throws rather than snapshotting "No content returned"', async () => {
    route(() => ({ data: { data: { markdown: '', metadata: {} } } }));

    await expect(scrapeWithProvider('firecrawl', 'https://example.com/page', 30)).rejects.toThrow(
      ScrapeError
    );
  });

  it('keeps content past the old 14,000-character truncation point', async () => {
    const markdown = `${'x'.repeat(20000)}\nSection 42: amended`;
    route(() => ({ data: { data: { markdown, metadata: { title: 'Long Act' } } } }));

    const { contentText } = await scrapeWithProvider('firecrawl', 'https://example.com/act', 30);

    expect(contentText).toContain('Section 42: amended');
    expect(contentText.length).toBeGreaterThan(20000);
  });
});

describe('Direct scrape', () => {
  const html = '<html><head><title>Main</title></head><body><main>Body text here</main></body></html>';

  it('throws rather than snapshotting "Failed to fetch content from"', async () => {
    route(() => {
      throw new Error('ECONNREFUSED');
    });

    await expect(scrapeWithProvider('direct', 'https://example.com/', 30)).rejects.toThrow(
      ScrapeError
    );
  });

  it('omits subpages that definitively do not exist', async () => {
    route((config) =>
      config.url === 'https://example.com/' ? { data: html } : { status: 404, data: 'Not Found' }
    );

    const { pages } = await scrapeWithProvider('direct', 'https://example.com/', 30);

    expect(pages).toHaveLength(1);
    expect(pages[0].type).toBe('page');
  });

  it('fails the scrape when a subpage is unreachable rather than dropping its content', async () => {
    // A 5xx or a timeout means we do not know whether the subpage still has
    // content. Omitting it would read as a large deletion in the next diff.
    route((config) =>
      config.url === 'https://example.com/'
        ? { data: html }
        : { status: 503, data: 'Service Unavailable' }
    );

    await expect(scrapeWithProvider('direct', 'https://example.com/', 30)).rejects.toThrow(
      ScrapeError
    );
  });

  it('keeps the whole page body rather than the first 5,000 characters', async () => {
    const long = 'word '.repeat(3000); // ~15,000 characters
    route((config) =>
      config.url === 'https://example.com/'
        ? {
            data: `<html><head><title>Long</title></head><body><main>${long}END-MARKER</main></body></html>`,
          }
        : { status: 404, data: 'Not Found' }
    );

    const { contentText } = await scrapeWithProvider('direct', 'https://example.com/', 30);

    expect(contentText).toContain('END-MARKER');
  });
});
