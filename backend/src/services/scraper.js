/**
 * Scraper service
 *
 * Options:
 *   Firecrawl   — full-page clean markdown via the Firecrawl API (best diffs)
 *   Brave       — Brave Search API indexed, clean page content/snippets
 *   Serper      — Serper (Google Search API) indexed snippets + news
 *   Direct      — axios + cheerio direct HTML fetch + text extraction (fallback)
 *
 * The SCRAPER_PROVIDER env var (brave | serper | firecrawl | auto) selects the
 * method; `auto` (the default) uses whichever provider's API key is configured.
 * See resolveScraperProvider() for the precedence rules.
 *
 * The Brave and Serper paths snapshot the monitored *page* rather than its whole
 * domain — a domain-wide `site:` query gives every URL on a shared host (21 Acts
 * on sso.agc.gov.sg, say) the same results, so each one would report on whatever
 * the host published most recently. Alongside that they run news and
 * announcement passes, which are domain-scoped on purpose: those are the
 * "what is happening around this site" signal.
 *
 * Neither path filters by recency. Both providers' recency filters were measured
 * to return zero results on a real monitored site even at their widest setting,
 * so recency comes from the dates on the results instead.
 *
 * Every scraper here either returns real content or throws a ScrapeError. It
 * must never return a placeholder string: a placeholder gets snapshotted like
 * any other body, so an outage produces a false "change" on the failing scan and
 * another one on recovery, and it poisons the baseline in between.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1';
const SERPER_API_BASE = 'https://google.serper.dev';
const FIRECRAWL_API_BASE = process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev/v1';
// Safety cap only. Content is no longer truncated for monitoring purposes —
// hashing a 14k prefix meant the later sections of a long Act or PDF were never
// watched. This bound exists purely so a pathological document cannot exhaust
// memory, and when it trips it says so rather than cutting off silently.
const MAX_CONTENT_CHARS = 2_000_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB cap to avoid huge downloads

// Subpaths tried when falling back to direct cheerio scraping
const SUBPATHS_TO_TRY = ['/blog', '/news', '/changelog', '/releases', '/announcements', '/updates', '/whats-new'];

/**
 * A scrape that could not produce trustworthy content.
 *
 * Callers record the engine as `error` and write no snapshot, which keeps the
 * baseline clean across an outage instead of diffing against a failure message.
 */
class ScrapeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ScrapeError';
    this.provider = options.provider;
    if (options.cause) this.cause = options.cause;
  }
}

/** Human-readable cause for an upstream failure, including HTTP status. */
function describeError(err) {
  if (!err) return 'unknown error';
  const status = err.response?.status;
  if (!status) return err.message || String(err);

  const payload = err.response?.data;
  const detail =
    (typeof payload === 'string' && payload) ||
    payload?.message ||
    payload?.error?.message ||
    payload?.error ||
    '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text ? `HTTP ${status} — ${String(text).slice(0, 200)}` : `HTTP ${status}`;
}

/** Apply the memory-safety cap, making any cut explicit in the content itself. */
function capContent(text) {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[content truncated at ${MAX_CONTENT_CHARS} characters]`;
}

/**
 * Normalise a publication date to `YYYY-MM-DD`, or return '' when the provider
 * gave a relative age.
 *
 * Brave (`r.age`) and Serper (`r.date`) routinely return strings like
 * "3 days ago". Those shift on every call for an unchanged page, so hashing them
 * makes nearly every scan look like a change. Relative ages are dropped from the
 * hashed body and kept only on the `pages` objects, which are not hashed and are
 * still shown to the LLM — the recency signal survives, the false diffs do not.
 */
function absoluteDate(raw) {
  if (!raw) return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (/(\bago\b|^just now$|^yesterday$|^today$|^\d+\s*[smhdwy]$)/i.test(text)) return '';

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * The search queries for a monitored URL, most precise first.
 *
 * Shapes and ordering here are measured against both live APIs, not inferred —
 * two rounds of inferring them shipped silent breakage:
 *
 *   site:<host><path>   1 result on Brave and on Serper: the monitored page
 *   site:<domain>       16 on Brave, 10 on Serper
 *   <domain>            plain text; the only shape no operator rule can refuse
 *
 * A quoted `"host/path"` rung used to sit second. It is gone: Brave returns
 * zero for it, and Serper treats it as an operator query like any other, so it
 * added a wasted call on both.
 *
 * The ladder exists because a provider can refuse a shape (HTTP 400) or quietly
 * match nothing with it (HTTP 200, no results). Neither is predictable per
 * account, so the entries get progressively plainer, ending domain-wide so a
 * page with no index presence of its own still reports something.
 *
 * `news` and `announcements` are deliberately domain-scoped at every rung. They
 * are the "what is happening around this site" signal; scoped to the page they
 * return only the monitored page itself — measured 0 results on Serper and 1 on
 * Brave, against 9-10 domain-scoped.
 *
 * @returns {Array<{ scope: string, primary: string, news: string,
 *                   announcements: string, pageScoped: boolean }>}
 */
function queryVariants(url, domain) {
  let host = domain;
  let path = '';
  try {
    const parsed = new URL(url);
    // The URL's real host, not the www-stripped `domain`: a host+path prefix
    // has to have both halves come from the same place.
    host = parsed.hostname;
    path = parsed.pathname.replace(/\/+$/, '');
  } catch {
    /* not a parseable URL — fall through to domain scope */
  }

  const news = domain;
  const announcements = `site:${domain} (blog OR changelog OR "release notes" OR announcement OR "what's new" OR news OR updates)`;

  const domainWide = {
    scope: `site:${domain}`,
    primary: `site:${domain}`,
    news,
    announcements,
    pageScoped: false,
  };
  const domainPlain = {
    scope: domain,
    primary: domain,
    news,
    announcements: `${domain} news updates`,
    pageScoped: false,
  };

  if (!path) return [domainWide, domainPlain];

  return [
    {
      scope: `site:${host}${path}`,
      primary: `site:${host}${path}`,
      news,
      announcements,
      pageScoped: true,
    },
    domainWide,
    domainPlain,
  ];
}

/**
 * Does this failure mean the provider refused the shape of the query?
 *
 * Search APIs answer a rejected query with 400 and an exhausted quota or a bad
 * key with 401/403, so a 400 is a reliable "this query is unacceptable" and a
 * safe trigger for retrying a simpler one. Retrying the *same* query would be
 * pointless: the rejection is deterministic.
 */
function isQueryRejection(err) {
  return err?.response?.status === 400;
}

/**
 * Query shapes a provider's account has been seen to refuse outright.
 *
 * A 400 belongs to the API key, not to any one website, so one discovery serves
 * every scan for the life of the process — otherwise a restricted account burns
 * a rejected call on every scan forever.
 */
const refusedVariants = new Map();

/**
 * The shape that last produced results for a given provider and URL.
 *
 * Deliberately separate from `refusedVariants`: an empty result set says
 * something about *this page* — it has no index entry of its own — not about
 * the account. Caching it per provider would let one obscure page drag every
 * other website down to domain-wide results.
 */
const productiveVariants = new Map();

/**
 * Run a provider's searches, stepping down to a plainer query shape when the
 * current one is refused or matches nothing.
 *
 * `run(variant)` performs that provider's searches and must reject with the
 * primary search's error when the primary fails — the primary is the snapshot,
 * so its failure is the engine's failure. It returns the scrape result carrying
 * `primaryCount`: how many results the *page-scoped* search produced.
 *
 * That count, not `pages.length`, is what "matched nothing" means. `pages` also
 * holds the news and announcement passes, which are domain-scoped at every rung
 * — so a page with no index entry of its own still came back with a dozen
 * domain-wide hits, the ladder read that as success, and the snapshot was
 * labelled page-scoped while containing nothing of the kind. Measured: Brave
 * has nothing indexed for `sso.agc.gov.sg/Act/WSHA2006`, yet returned 4 pages.
 *
 * Two different signals, handled differently:
 *
 *  - **Refused (400).** The shape is unusable for this key. Remember it and
 *    never try it again this process.
 *  - **Zero results (200).** The shape is legal but found nothing for this page.
 *    Try a plainer one, because an empty supplementary section is no use to
 *    anybody — but remember it per URL, not per account.
 *
 * When nothing produces results the most precise attempt is what gets kept, so
 * the snapshot stays page-scoped and stable rather than flapping between
 * shapes. Errors that are not refusals propagate immediately: a 429 is a rate
 * limit, and a plainer query would only spend more of an exhausted quota.
 */
async function withQueryFallback(provider, url, domain, run) {
  const variants = queryVariants(url, domain);
  const refusedFloor = refusedVariants.get(provider) ?? 0;
  const start = Math.min(
    Math.max(refusedFloor, productiveVariants.get(`${provider} ${url}`) ?? 0),
    variants.length - 1
  );

  let lastError;
  let firstEmpty = null;

  for (let i = start; i < variants.length; i += 1) {
    let result;
    try {
      result = await run(variants[i]);
    } catch (err) {
      lastError = err;
      if (!isQueryRejection(err)) throw err;
      refusedVariants.set(provider, i + 1);
      continue;
    }

    if (primaryResultCount(result) > 0) {
      productiveVariants.set(`${provider} ${url}`, i);
      return result;
    }

    // Legal query, nothing indexed under it. Keep the most precise empty result
    // in case every shape comes up empty, and try something broader.
    if (firstEmpty === null) firstEmpty = result;
  }

  if (firstEmpty) {
    // Nothing anywhere on the ladder could see this page. Say so on the result
    // rather than letting a page-scoped label sit above domain-wide context.
    // Notes are not part of the hashed snapshot body, so this cannot diff.
    firstEmpty.notes.push(
      `No search result matched ${url} itself under any query form; any results listed cover ${domain} generally.`
    );
    return firstEmpty;
  }

  // Every shape refused. Say that, rather than surfacing the bare
  // "Request failed with status code 400" — which query was rejected is the
  // only thing that makes this actionable.
  throw new ScrapeError(
    `${provider} refused every query form for ${url}: ${describeError(lastError)}`,
    { provider, cause: lastError }
  );
}

/**
 * How many results the primary (page-scoped) search returned.
 *
 * Falls back to the full page count for a provider that does not report one,
 * which keeps the old behaviour rather than treating the result as empty.
 */
function primaryResultCount(result) {
  return result.primaryCount ?? result.pages.length;
}

/** Test seam: forget what providers have been seen to refuse or find. */
function resetQueryVariantCache() {
  refusedVariants.clear();
  productiveVariants.clear();
}

/**
 * Scrape a website and return structured content.
 *
 * If the URL points to a PDF, the PDF is downloaded and its text extracted —
 * search APIs and HTML scraping are bypassed entirely so diffs reflect only
 * changes within the document itself.
 *
 * @param {string} url
 * @returns {{ contentText: string, source: 'pdf'|'firecrawl'|'brave'|'direct', pages: Array }}
 */
async function scrapeWebsite(url) {
  if (await isPdfUrl(url)) {
    return scrapePdf(url);
  }

  const provider = resolveScraperProvider();
  if (provider === 'firecrawl') {
    return scrapeWithFirecrawl(url);
  }
  if (provider === 'brave') {
    return scrapeWithBrave(url);
  }
  if (provider === 'serper') {
    return scrapeWithSerper(url);
  }
  return scrapeWithCheerio(url);
}

/**
 * Resolve which scraping backend to use based on SCRAPER_PROVIDER and which
 * API keys are configured. Returns 'firecrawl' | 'brave' | 'serper' | 'direct'.
 *
 * Precedence:
 *   - SCRAPER_PROVIDER=firecrawl → firecrawl if FIRECRAWL_API_KEY set, else auto
 *   - SCRAPER_PROVIDER=brave     → brave if BRAVE_API_KEY set, else auto
 *   - SCRAPER_PROVIDER=serper    → serper if SERPER_API_KEY set, else auto
 *   - auto (default/unset)       → firecrawl if FIRECRAWL_API_KEY, else brave if
 *                                  BRAVE_API_KEY, else serper if SERPER_API_KEY,
 *                                  else direct
 *
 * In `auto`, Firecrawl is preferred over the search APIs because full-page
 * content yields richer change detection than indexed snippets.
 */
function resolveScraperProvider() {
  const hasFirecrawl = !!process.env.FIRECRAWL_API_KEY;
  const hasBrave = !!process.env.BRAVE_API_KEY;
  const hasSerper = !!process.env.SERPER_API_KEY;
  const preference = (process.env.SCRAPER_PROVIDER || 'auto').toLowerCase();

  if (preference === 'firecrawl') {
    if (hasFirecrawl) return 'firecrawl';
    console.warn('SCRAPER_PROVIDER=firecrawl but FIRECRAWL_API_KEY is not set — falling back to auto selection.');
  } else if (preference === 'brave') {
    if (hasBrave) return 'brave';
    console.warn('SCRAPER_PROVIDER=brave but BRAVE_API_KEY is not set — falling back to auto selection.');
  } else if (preference === 'serper') {
    if (hasSerper) return 'serper';
    console.warn('SCRAPER_PROVIDER=serper but SERPER_API_KEY is not set — falling back to auto selection.');
  }

  // auto (and the fall-through cases above)
  if (hasFirecrawl) return 'firecrawl';
  if (hasBrave) return 'brave';
  if (hasSerper) return 'serper';
  return 'direct';
}

/** Which engines the deployment holds an API key for. `direct` needs none. */
const ENGINE_KEY_ENV = {
  firecrawl: 'FIRECRAWL_API_KEY',
  brave: 'BRAVE_API_KEY',
  serper: 'SERPER_API_KEY',
};

/**
 * Filter requested engines down to the ones this deployment can actually run.
 *
 * Selecting an engine whose key is missing fails every scan for that engine, so
 * the check belongs next to `resolveScraperProvider`, which already encodes the
 * same key precedence — rather than in a caller that would drift from it.
 *
 * @param {string[]} requested
 * @returns {string[]}
 */
function availableEngines(requested) {
  return requested.filter((engine) => {
    const key = ENGINE_KEY_ENV[engine];
    return !key || Boolean(process.env[key]);
  });
}

/**
 * Scrape with an explicitly named provider (bypasses auto-resolution).
 * Used when a website opts into specific engines (Firecrawl and/or Brave).
 *
 * @param {'firecrawl'|'brave'|'serper'|'direct'} provider
 * @param {string} url
 * @returns {{ contentText: string, source: string, pages: Array }}
 */
async function scrapeWithProvider(provider, url) {
  if (provider === 'firecrawl') return scrapeWithFirecrawl(url);
  if (provider === 'brave') return scrapeWithBrave(url);
  if (provider === 'serper') return scrapeWithSerper(url);
  return scrapeWithCheerio(url);
}

// ---------------------------------------------------------------------------
// PDF scraping
// ---------------------------------------------------------------------------

/**
 * Detect whether a URL points to a PDF. Checks the URL extension first;
 * falls back to a HEAD request when the extension is ambiguous.
 */
async function isPdfUrl(url) {
  try {
    const { pathname } = new URL(url);
    if (/\.pdf(\?|#|$)/i.test(pathname)) return true;
  } catch {
    // fall through to HEAD check
  }

  try {
    const head = await axios.head(url, {
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const ct = (head.headers['content-type'] || '').toLowerCase();
    return ct.includes('application/pdf');
  } catch {
    return false;
  }
}

async function scrapePdf(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    maxContentLength: MAX_PDF_BYTES,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; WebMonitor/1.0; +https://github.com/website-monitor)',
      Accept: 'application/pdf,*/*',
    },
  });

  const buffer = Buffer.from(response.data);

  // Attempt text extraction, but never let a parse failure (encrypted,
  // image-only or malformed PDFs) abort the scan — a snapshot must always be
  // produced so changes can still be detected on the next scan.
  let rawText = '';
  let info = {};
  let numPages = 0;
  let parseError = null;
  try {
    const parsed = await pdfParse(buffer);
    rawText = (parsed.text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[ ]{3,}/g, '  ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    info = parsed.info || {};
    numPages = parsed.numpages || 0;
  } catch (err) {
    parseError = err.message;
    console.warn(`PDF text extraction failed for ${url}: ${err.message}`);
  }

  const title = info.Title || '';
  const author = info.Author || '';

  const headerLines = [
    `PDF document: ${url}`,
    title ? `Title: ${title}` : null,
    author ? `Author: ${author}` : null,
    numPages ? `Pages: ${numPages}` : null,
    '',
  ].filter((l) => l !== null);

  // Body: extracted text when available, otherwise a byte-level fingerprint so
  // diffs between scans still flag when the underlying file changes.
  let body;
  if (rawText) {
    body = rawText;
  } else {
    const fingerprint = crypto.createHash('sha256').update(buffer).digest('hex');
    body = [
      parseError
        ? `[PDF text could not be extracted: ${parseError}]`
        : '[PDF contained no extractable text]',
      `Bytes: ${buffer.length}`,
      `Content fingerprint: ${fingerprint}`,
    ].join('\n');
  }

  const contentText = capContent(headerLines.join('\n') + '\n' + body);

  const pages = [{
    type: 'pdf',
    url,
    title: title || url.split('/').pop() || 'document.pdf',
    description: author ? `Author: ${author}` : '',
    numPages,
  }];

  return { contentText, source: 'pdf', pages };
}

// ---------------------------------------------------------------------------
// Brave Search API
// ---------------------------------------------------------------------------


async function scrapeWithBrave(url) {
  const domain = extractDomain(url);

  return withQueryFallback('brave', url, domain, async (queries) => {
    // Three parallel searches:
    //  1. Indexed pages at the monitored path (main content snapshot)
    //  2. News coverage mentioning the page or domain
    //  3. Announcement / changelog / release pages at that path
    // No recency filter anywhere. Measured on this deployment's own key:
    // `site:mtcr.info` returns 16 results unfiltered and **0** at every
    // freshness setting including `py` ("past year"), and the announcements
    // query goes 9 -> 0 the same way. It was applied to both `/web/search`
    // calls, which is what emptied Brave entirely.
    //
    // Recency is not lost: results carry `page_age`, which `absoluteDate`
    // normalises and the prompt shows. The dates come from the results rather
    // than from a server-side filter that returns nothing.
    const [webResults, newsResults, announcementResults] = await Promise.allSettled([
      braveFetch('/web/search', { q: queries.primary, count: 20 }),
      braveFetch('/news/search', { q: queries.news, count: 10 }),
      braveFetch('/web/search', { q: queries.announcements, count: 10 }),
    ]);

    // The primary search is the snapshot. If it failed — an exhausted quota, a
    // rate limit, a network blip — we do not know what is indexed, and
    // pretending we saw nothing would diff as "every page removed". Rejecting
    // with the raw error lets withQueryFallback see a 400 and try a plainer
    // query before giving up.
    if (webResults.status === 'rejected') {
      if (isQueryRejection(webResults.reason)) throw webResults.reason;
      throw new ScrapeError(
        `Brave web search failed for ${url}: ${describeError(webResults.reason)}`,
        { provider: 'brave', cause: webResults.reason }
      );
    }

    const pages = [];
    const notes = [
      queries.pageScoped
        ? `Brave query: ${queries.scope}`
        : `Brave query: ${queries.scope} — nothing is indexed for this page on its own, so these results cover the whole domain`,
    ];

    collectPages(pages, webResults.value?.web?.results, (r) => ({
      type: 'web',
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
      published: r.page_age || r.age || '',
      publishedDate: absoluteDate(r.page_age || r.age),
    }));

    // Counted before the domain-scoped passes append to `pages`: this is the
    // only number that says whether the monitored page is indexed at all.
    const primaryCount = pages.length;

    if (newsResults.status === 'fulfilled') {
      // `meta_url.path` was previously used as a date fallback; it is a URL path,
      // not a date, so it is gone.
      collectPages(pages, newsResults.value?.results, (r) => ({
        type: 'news',
        title: r.title || '',
        url: r.url || '',
        description: r.description || '',
        published: r.age || '',
        publishedDate: absoluteDate(r.age),
      }));
    } else {
      notes.push(`Brave news search unavailable: ${describeError(newsResults.reason)}`);
    }

    if (announcementResults.status === 'fulfilled') {
      collectPages(pages, announcementResults.value?.web?.results, (r) => ({
        type: 'announcement',
        title: r.title || '',
        url: r.url || '',
        description: r.description || '',
        published: r.page_age || r.age || '',
        publishedDate: absoluteDate(r.page_age || r.age),
      }));
    } else {
      notes.push(`Brave announcement search unavailable: ${describeError(announcementResults.reason)}`);
    }

    return {
      contentText: capContent(canonicalSearchContent(url, pages)),
      source: 'brave',
      pages,
      notes,
      primaryCount,
    };
  });
}

async function braveFetch(endpoint, params) {
  const response = await axios.get(`${BRAVE_API_BASE}${endpoint}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
    params,
    timeout: 15000,
  });
  return response.data;
}

/**
 * Append mapped results to `pages`, skipping URLs already present.
 *
 * Deduplication used to apply only to the announcement pass, so a page indexed
 * as both web and news appeared twice and its ordering drove a spurious diff.
 */
function collectPages(pages, results, map) {
  for (const r of results || []) {
    const page = map(r);
    if (!page.url) continue;
    if (pages.some((p) => p.url === page.url)) continue;
    pages.push(page);
  }
}

/**
 * Format an indexed-page list (from Brave or Serper) into the body that gets
 * hashed and diffed.
 *
 * One line per result, sorted by URL, no ordinals and no relative ages. The old
 * format numbered results `[1]`, `[2]`… in raw API order, so a reshuffle of
 * unchanged results rewrote the entire body. Sorting by URL also turns the
 * line diff into a genuine set comparison for free: an added line is a page
 * that appeared, a removed line is a page that dropped out of the index.
 *
 * The query itself is deliberately NOT in here. It describes how we looked, not
 * what the page says, so including it meant that changing our own query
 * strategy registered as a change to the monitored site. It goes in `notes`,
 * which reaches the report without reaching the hash.
 */
function canonicalSearchContent(url, pages) {
  const rows = pages
    .map((p) => ({
      url: p.url || '',
      title: (p.title || '').replace(/\s+/g, ' ').trim(),
      date: p.publishedDate || '',
    }))
    .sort((a, b) => a.url.localeCompare(b.url) || a.title.localeCompare(b.title))
    .map((r) => [r.url, r.title, r.date].filter(Boolean).join(' | '));

  return [
    `Website: ${url}`,
    `Results (${rows.length}):`,
    '',
    ...rows,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Serper (Google Search API)
// ---------------------------------------------------------------------------


async function scrapeWithSerper(url) {
  const domain = extractDomain(url);

  return withQueryFallback('serper', url, domain, async (queries) => {
    // Three parallel searches mirroring the Brave strategy, scoped to the
    // monitored path rather than the whole domain.
    // `num: 10`, not 20. Measured against a free Serper account: any query
    // containing a search operator returns
    // `400 "Query pattern not allowed for free accounts."` when `num > 10` —
    // the boundary is exact, 10 passes and 11 fails — while the same query at
    // `num: 10` returns results. `num: 20` on this call is what has been
    // failing Serper, not any particular operator.
    //
    // No `tbs`, for the same reason Brave has no freshness, and measured the
    // same way: the announcements query returns 10 results without it and 0
    // with, and `/news` returns 8 without and 0 with.
    const [webResults, newsResults, announcementResults] = await Promise.allSettled([
      serperFetch('/search', { q: queries.primary, num: 10 }),
      serperFetch('/news', { q: queries.news, num: 10 }),
      serperFetch('/search', { q: queries.announcements, num: 10 }),
    ]);

    if (webResults.status === 'rejected') {
      // A 400 is Serper refusing the query shape — free accounts reject some
      // operators. Let withQueryFallback retry with a plainer one rather than
      // failing the engine.
      if (isQueryRejection(webResults.reason)) throw webResults.reason;
      throw new ScrapeError(
        `Serper web search failed for ${url}: ${describeError(webResults.reason)}`,
        { provider: 'serper', cause: webResults.reason }
      );
    }

    const pages = [];
    const notes = [
      queries.pageScoped
        ? `Serper query: ${queries.scope}`
        : `Serper query: ${queries.scope} — nothing is indexed for this page on its own, so these results cover the whole domain`,
    ];

    collectPages(pages, webResults.value?.organic, (r) => ({
      type: 'web',
      title: r.title || '',
      url: r.link || '',
      description: r.snippet || '',
      published: r.date || '',
      publishedDate: absoluteDate(r.date),
    }));

    const primaryCount = pages.length;

    if (newsResults.status === 'fulfilled') {
      collectPages(pages, newsResults.value?.news, (r) => ({
        type: 'news',
        title: r.title || '',
        url: r.link || '',
        description: r.snippet || '',
        published: r.date || '',
        publishedDate: absoluteDate(r.date),
      }));
    } else {
      notes.push(`Serper news search unavailable: ${describeError(newsResults.reason)}`);
    }

    if (announcementResults.status === 'fulfilled') {
      collectPages(pages, announcementResults.value?.organic, (r) => ({
        type: 'announcement',
        title: r.title || '',
        url: r.link || '',
        description: r.snippet || '',
        published: r.date || '',
        publishedDate: absoluteDate(r.date),
      }));
    } else {
      notes.push(`Serper announcement search unavailable: ${describeError(announcementResults.reason)}`);
    }

    return {
      contentText: capContent(canonicalSearchContent(url, pages)),
      source: 'serper',
      pages,
      notes,
      primaryCount,
    };
  });
}

async function serperFetch(endpoint, body) {
  const response = await axios.post(`${SERPER_API_BASE}${endpoint}`, body, {
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// Firecrawl API
// ---------------------------------------------------------------------------

/**
 * Scrape a single page with Firecrawl, returning its clean full-page markdown.
 * Unlike Brave (which returns indexed snippets), this captures the actual
 * rendered page content, producing far richer diffs.
 */
async function scrapeWithFirecrawl(url) {
  const domain = extractDomain(url);

  const resp = await axios.post(
    `${FIRECRAWL_API_BASE}/scrape`,
    { url, formats: ['markdown'], onlyMainContent: true },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      timeout: 60000, // Firecrawl renders JS; allow a generous timeout
    }
  );

  const data = resp.data?.data || {};
  const md = data.markdown || '';
  const meta = data.metadata || {};
  const title = meta.title || '';
  const description = meta.description || '';

  if (!md) {
    // Previously snapshotted as "No content returned by Firecrawl for …", which
    // then diffed against the real page on the next successful scan.
    throw new ScrapeError(`Firecrawl returned no content for ${url}`, { provider: 'firecrawl' });
  }

  const header = [
    `Website: ${url}`,
    `Domain: ${domain}`,
    title ? `Title: ${title}` : null,
    description ? `Description: ${description}` : null,
    '',
  ].filter((l) => l !== null).join('\n');

  const contentText = capContent(header + '\n' + md);

  const pages = [{
    type: 'page',
    url,
    title: title || url,
    description,
  }];

  return { contentText, source: 'firecrawl', pages, notes: [] };
}

// ---------------------------------------------------------------------------
// Direct fetch fallback (axios + cheerio)
// ---------------------------------------------------------------------------

async function scrapeWithCheerio(url) {
  // The monitored page itself is fetched outside the settled batch: if it does
  // not load we have nothing to compare, and a placeholder body would diff
  // against the real page on recovery.
  let mainPage;
  try {
    mainPage = await fetchPage(url);
  } catch (err) {
    throw new ScrapeError(`Failed to fetch content from ${url}: ${describeError(err)}`, {
      provider: 'direct',
      cause: err,
    });
  }
  if (!mainPage || mainPage.absent) {
    throw new ScrapeError(
      `Failed to fetch content from ${url}${mainPage?.reason ? `: ${mainPage.reason}` : ''}`,
      { provider: 'direct' }
    );
  }

  const subpaths = SUBPATHS_TO_TRY.slice(0, 4);
  const subPages = await Promise.allSettled(
    subpaths.map((path) => fetchPage(buildSubpageUrl(url, path)))
  );

  const pages = [{ type: 'page', ...mainPage }];
  const notes = [];

  subPages.forEach((sp, i) => {
    if (sp.status === 'rejected') {
      // A 5xx or a network error means we do not know whether the subpage still
      // has content. Dropping it would read as a large deletion in the diff, so
      // the whole scrape fails instead and the baseline is left alone.
      throw new ScrapeError(
        `Failed to fetch ${buildSubpageUrl(url, subpaths[i])}: ${describeError(sp.reason)}`,
        { provider: 'direct', cause: sp.reason }
      );
    }
    if (sp.value.absent) return; // definitive 4xx — the subpage simply is not there
    pages.push({ type: 'subpage', ...sp.value });
  });

  const contentText = pages
    .map((p) => {
      const lines = [`[${p.type.toUpperCase()}] ${p.title} — ${p.url}`];
      if (p.description) lines.push(`Description: ${p.description}`);
      lines.push('', p.bodyText || '');
      return lines.join('\n');
    })
    .join('\n\n---\n\n');

  return {
    contentText: capContent(contentText),
    source: 'direct',
    pages: pages.map(({ bodyText: _b, ...rest }) => rest), // strip raw body from page list
    notes,
  };
}

/**
 * Fetch a single URL and extract clean text.
 *
 * Resolves to `{ absent: true }` for a definitive 4xx (the page is not there)
 * and throws for anything indeterminate — a 5xx, a timeout, a connection reset.
 * It used to swallow every error and return null, which made "the page is gone"
 * and "we could not reach it" indistinguishable.
 */
async function fetchPage(url) {
  let response;
  try {
    response = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; WebMonitor/1.0; +https://github.com/website-monitor)',
      },
      maxRedirects: 5,
    });
  } catch (err) {
    const status = err.response?.status;
    if (status && status >= 400 && status < 500) {
      return { absent: true, reason: describeError(err) };
    }
    throw err;
  }

  if (!response.data || typeof response.data !== 'string') {
    return { absent: true, reason: 'response was not HTML' };
  }

  const $ = cheerio.load(response.data);

  // Remove noise
  $('script, style, noscript, svg, iframe, nav, footer, [role="banner"], .cookie-banner, #cookie-consent').remove();

  const title = $('title').text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';

  // Extract main content area
  const contentSelectors = ['main', 'article', '[role="main"]', '#content', '.content', '#main', '.main', 'body'];
  let contentEl = null;
  for (const sel of contentSelectors) {
    if ($(sel).length) {
      contentEl = $(sel).first();
      break;
    }
  }

  // No per-page slice: the whole body is kept so changes further down the page
  // are monitored rather than silently dropped.
  const rawText = (contentEl || $('body')).text();
  const bodyText = rawText
    .replace(/\t/g, ' ')
    .replace(/[ ]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { url, title, description: metaDesc, bodyText };
}

function buildSubpageUrl(baseUrl, path) {
  try {
    const { origin } = new URL(baseUrl);
    return `${origin}${path}`;
  } catch {
    return `${baseUrl}${path}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

module.exports = {
  scrapeWebsite,
  scrapeWithProvider,
  availableEngines,
  resetQueryVariantCache,
  scrapePdf,
  isPdfUrl,
  extractDomain,
  resolveScraperProvider,
  ScrapeError,
};
