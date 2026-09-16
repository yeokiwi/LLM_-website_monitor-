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
const {
  scrapeWithProvider,
  ScrapeError,
  resetQueryVariantCache,
} = require('../src/services/scraper');
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
  // Which query shape a provider accepts is remembered process-wide, so each
  // test starts from the most precise one.
  resetQueryVariantCache();
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
    // Asserted as page scoping rather than a specific operator: which operators
    // an account may use is the provider's business, not this test's.
    expect(queries[0]).toContain('/Act/WSHA2006');
    expect(queries[0]).not.toBe('site:sso.agc.gov.sg');
  });

  it('scopes by exact phrase, because Brave\'s site: takes no path', async () => {
    const queries = [];
    route((config) => {
      queries.push(queryOf(config));
      return isNewsCall(config) ? { data: { results: [] } } : { data: { web: { results: [] } } };
    });

    await scrapeWithProvider('brave', 'https://www.mtcr.info/en/mtcr-annex', 30);

    // Brave documents `site:` for domains and subdomains only. A path inside it
    // matches nothing and returns a healthy, empty 200 — which is how this got
    // reported as "zero indexed results" rather than as an error.
    expect(queries[0]).toBe('"www.mtcr.info/en/mtcr-annex"');
    expect(queries.join(' ')).not.toContain('inurl:');
    expect(queries.join(' ')).not.toContain('site:www.mtcr.info/en');
  });

  it('does not filter the snapshot query by recency', async () => {
    // The primary is the snapshot: "what is indexed here now". Filtering it by
    // freshness starves a stable page of results, and makes the snapshot shrink
    // on its own as entries age out — which then diffs as pages being removed.
    const calls = [];
    route((config) => {
      calls.push({ url: config.url, freshness: config.params?.freshness });
      return isNewsCall(config) ? { data: { results: [] } } : { data: { web: { results: [] } } };
    });

    await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    expect(calls[0].freshness).toBeUndefined();
    // Recency is still the point of the news and announcement passes.
    expect(calls.slice(1).some((c) => c.freshness === 'pm')).toBe(true);
  });

  it('keeps the host the URL actually used, so the path prefix matches', async () => {
    const queries = [];
    route((config) => {
      queries.push(queryOf(config));
      return isNewsCall(config) ? { data: { results: [] } } : { data: { web: { results: [] } } };
    });

    await scrapeWithProvider('brave', 'https://www.mtcr.info/en/mtcr-annex', 30);

    // Not the www-stripped `domain`: `site:mtcr.info/en/...` pairs a host with a
    // path that never appeared together.
    expect(queries[0]).toContain('www.mtcr.info');
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

describe('restricted accounts (the query-pattern fallback)', () => {
  /**
   * Refuse any query matching `reject`, answer everything else. Mirrors a free
   * Serper account: the rejection is a 400, deterministic per query shape.
   */
  function rejectPattern(reject, { organic = [], web = [] } = {}) {
    const attempted = [];
    route((config) => {
      const q = queryOf(config);
      attempted.push(q);
      if (reject.test(q)) {
        return { status: 400, data: { message: 'Query pattern not allowed for free accounts' } };
      }
      if (isNewsCall(config)) return { data: { news: [], results: [] } };
      return { data: { organic, web: { results: web } } };
    });
    return attempted;
  }

  it('retries with a plainer query when Serper refuses the shape', async () => {
    // This is the reported bug: the engine used to fail outright.
    const attempted = rejectPattern(/^site:/, {
      organic: [{ link: 'https://www.mtcr.info/en/mtcr-annex', title: 'MTCR Annex', snippet: 'x' }],
    });

    const { contentText } = await scrapeWithProvider(
      'serper',
      'https://www.mtcr.info/en/mtcr-annex',
      30
    );

    expect(attempted[0]).toBe('site:www.mtcr.info/en/mtcr-annex');
    expect(attempted).toContain('"www.mtcr.info/en/mtcr-annex"');
    expect(contentText).toContain('https://www.mtcr.info/en/mtcr-annex');
  });

  it('does the same for Brave', async () => {
    const attempted = rejectPattern(/^site:/, {
      web: [{ url: 'https://example.com/page', title: 'Page', description: 'x' }],
    });

    const { contentText } = await scrapeWithProvider('brave', 'https://example.com/page', 30);

    expect(attempted.some((q) => q.startsWith('"'))).toBe(true);
    expect(contentText).toContain('https://example.com/page');
  });

  it('falls all the way back to a domain-wide query', async () => {
    // An account that refuses both the scoped and the quoted shape still gets
    // results, just without page scoping.
    const attempted = rejectPattern(/mtcr-annex/, {
      organic: [{ link: 'https://www.mtcr.info/other', title: 'Other', snippet: 'x' }],
    });

    const { contentText } = await scrapeWithProvider(
      'serper',
      'https://www.mtcr.info/en/mtcr-annex',
      30
    );

    expect(attempted).toContain('site:mtcr.info');
    expect(contentText).toContain('https://www.mtcr.info/other');
  });

  it('remembers the accepted shape, so later scans waste no call on it', async () => {
    const first = rejectPattern(/^site:/, { organic: [] });
    await scrapeWithProvider('serper', 'https://www.mtcr.info/en/mtcr-annex', 30);
    expect(first.some((q) => q.startsWith('site:'))).toBe(true);

    // A second scrape — of a different page, since the limit is account-wide.
    const second = rejectPattern(/^site:/, { organic: [] });
    await scrapeWithProvider('serper', 'https://www.mtcr.info/en/another-page', 30);

    expect(second.some((q) => q.startsWith('site:'))).toBe(false);
  });

  it('still throws once every shape has been refused', async () => {
    // A dead key must not be quietly downgraded to "nothing is indexed" — that
    // would diff as every page having been removed.
    rejectPattern(/.*/);

    const attempt = () => scrapeWithProvider('serper', 'https://www.mtcr.info/en/mtcr-annex', 30);
    await expect(attempt()).rejects.toThrow(ScrapeError);
    // The message has to name the problem, not just "status code 400".
    await expect(attempt()).rejects.toThrow(/refused every query form/);
  });

  it('gives a bare domain an operator-free shape to fall back to', async () => {
    const attempted = rejectPattern(/^site:/, { organic: [] });

    await scrapeWithProvider('serper', 'https://example.com', 30);

    expect(attempted[0]).toBe('site:example.com');
    expect(attempted).toContain('example.com');
  });

  it('does not retry a failure that is not about the query', async () => {
    // A 429 is a rate limit, not a bad query: a plainer query would not help,
    // and retrying would just spend more of an exhausted quota.
    const primaries = [];
    route((config) => {
      if (isNewsCall(config)) return { data: { news: [] } };
      primaries.push(queryOf(config));
      return { status: 429, data: { message: 'Rate limit exceeded' } };
    });

    await expect(
      scrapeWithProvider('serper', 'https://www.mtcr.info/en/mtcr-annex', 30)
    ).rejects.toThrow(ScrapeError);

    // One variant attempted: the primary and the announcements query of the
    // first shape, and no second shape after them.
    expect(primaries.every((q) => q.startsWith('site:www.mtcr.info/en/mtcr-annex'))).toBe(true);
  });
});

describe('pages with no index entry of their own', () => {
  /** Answer only queries matching `productive`; everything else returns 0 hits. */
  function onlyProductiveFor(productive, hits) {
    const attempted = [];
    route((config) => {
      const q = queryOf(config);
      attempted.push(q);
      const match = productive.test(q);
      if (isNewsCall(config)) return { data: { results: [], news: [] } };
      return {
        data: {
          web: { results: match ? hits : [] },
          organic: match ? hits : [],
        },
      };
    });
    return attempted;
  }

  it('widens the scope when the page-scoped query finds nothing', async () => {
    // The reported symptom: Brave answered 200 with zero results, so the report
    // said "zero indexed results" and there was no error to react to.
    const attempted = onlyProductiveFor(/^site:mtcr\.info$/, [
      { url: 'https://www.mtcr.info/en/news', title: 'MTCR News', description: 'x' },
    ]);

    const { contentText, pages, notes } = await scrapeWithProvider(
      'brave',
      'https://www.mtcr.info/en/mtcr-annex',
      30
    );

    expect(attempted[0]).toBe('"www.mtcr.info/en/mtcr-annex"');
    expect(attempted).toContain('site:mtcr.info');
    expect(pages.length).toBeGreaterThan(0);
    expect(contentText).toContain('https://www.mtcr.info/en/news');
    // Domain-wide results for a page-level monitor have to say so, or the
    // report silently claims the page changed when the host did.
    expect(notes.join(' ')).toMatch(/whole domain/i);
  });

  it('says nothing about the domain when the page itself has results', async () => {
    onlyProductiveFor(/mtcr-annex/, [
      { url: 'https://www.mtcr.info/en/mtcr-annex', title: 'Annex', description: 'x' },
    ]);

    const { notes } = await scrapeWithProvider(
      'brave',
      'https://www.mtcr.info/en/mtcr-annex',
      30
    );

    expect(notes.join(' ')).not.toMatch(/whole domain/i);
  });

  it('keeps the page-scoped result when every shape is empty', async () => {
    // Nothing anywhere: the snapshot should stay page-scoped and stable rather
    // than settling on whichever empty query happened to run last.
    const attempted = onlyProductiveFor(/never-matches/, []);

    const { contentText, pages } = await scrapeWithProvider(
      'brave',
      'https://www.mtcr.info/en/mtcr-annex',
      30
    );

    expect(pages).toHaveLength(0);
    expect(contentText).toContain('Results (0):');
    expect(attempted).toContain('site:mtcr.info'); // it did try to widen
  });

  it('remembers the productive scope per URL, not per account', async () => {
    // An obscure page falling back to domain-wide must not drag every other
    // website down with it.
    onlyProductiveFor(/^site:mtcr\.info$/, [
      { url: 'https://www.mtcr.info/en/news', title: 'News', description: 'x' },
    ]);
    await scrapeWithProvider('brave', 'https://www.mtcr.info/en/mtcr-annex', 30);

    const other = onlyProductiveFor(/other-page/, [
      { url: 'https://www.mtcr.info/en/other-page', title: 'Other', description: 'x' },
    ]);
    await scrapeWithProvider('brave', 'https://www.mtcr.info/en/other-page', 30);

    // The second URL starts at its own most precise shape.
    expect(other[0]).toBe('"www.mtcr.info/en/other-page"');
  });

  it('does not widen a bare-domain monitor past its own domain', async () => {
    const attempted = onlyProductiveFor(/never-matches/, []);

    await scrapeWithProvider('brave', 'https://example.com', 30);

    expect(attempted.every((q) => q.includes('example.com'))).toBe(true);
  });
});

describe('the query is not part of the content', () => {
  it('leaves the query out of the hashed body', async () => {
    mockBrave({ web: [braveWebResult('https://example.com/a', 'Page A', '1 day ago')] });
    const { contentText, notes } = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    // How we looked is configuration, not content: baking it into the snapshot
    // made changing our own query strategy read as a change to the site.
    // (Checking for a bare 'site:' would false-positive on "Website:".)
    expect(contentText).not.toContain('Query scope');
    expect(contentText).not.toContain('Brave query');
    // It still reaches the report.
    expect(notes.join(' ')).toContain('example.com/docs');
  });

  it('gives identical content for identical results found by different queries', async () => {
    const hit = braveWebResult('https://example.com/a', 'Page A', '2 days ago');

    mockBrave({ web: [hit] });
    const scoped = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    // Force the plainer query shape, then return the same results.
    resetQueryVariantCache();
    route((config) => {
      const q = queryOf(config);
      if (q.startsWith('site:')) {
        return { status: 400, data: { message: 'Query pattern not allowed for free accounts' } };
      }
      if (isNewsCall(config)) return { data: { results: [] } };
      return { data: { web: { results: [hit] } } };
    });
    const plain = await scrapeWithProvider('brave', 'https://example.com/docs', 30);

    expect(plain.contentText).toBe(scoped.contentText);
    expect(computeDiff(scoped.contentText, plain.contentText).hasChanges).toBe(false);
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
