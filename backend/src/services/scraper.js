/**
 * Scraper service
 *
 * Options:
 *   Firecrawl   — full-page clean markdown via the Firecrawl API (best diffs)
 *   Brave       — Brave Search API indexed, clean page content/snippets
 *   Direct      — axios + cheerio direct HTML fetch + text extraction (fallback)
 *
 * The SCRAPER_PROVIDER env var (brave | firecrawl | auto) selects the method;
 * `auto` (the default) uses whichever provider's API key is configured. See
 * resolveScraperProvider() for the precedence rules.
 *
 * The Brave path is period-aware: it adjusts search freshness so recent
 * content is surfaced first, and runs a dedicated "announcements" search
 * to capture releases, changelog entries, and blog posts.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1';
const FIRECRAWL_API_BASE = process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev/v1';
const MAX_CONTENT_CHARS = 14000; // slightly larger to give LLM more context
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB cap to avoid huge downloads

// Subpaths tried when falling back to direct cheerio scraping
const SUBPATHS_TO_TRY = ['/blog', '/news', '/changelog', '/releases', '/announcements', '/updates', '/whats-new'];

/**
 * Scrape a website and return structured content.
 *
 * If the URL points to a PDF, the PDF is downloaded and its text extracted —
 * search APIs and HTML scraping are bypassed entirely so diffs reflect only
 * changes within the document itself.
 *
 * @param {string} url
 * @param {number} [periodDays=30] — used to tune search freshness
 * @returns {{ contentText: string, source: 'pdf'|'firecrawl'|'brave'|'direct', pages: Array }}
 */
async function scrapeWebsite(url, periodDays = 30) {
  if (await isPdfUrl(url)) {
    return scrapePdf(url);
  }

  const provider = resolveScraperProvider();
  if (provider === 'firecrawl') {
    return scrapeWithFirecrawl(url);
  }
  if (provider === 'brave') {
    return scrapeWithBrave(url, periodDays);
  }
  return scrapeWithCheerio(url);
}

/**
 * Resolve which scraping backend to use based on SCRAPER_PROVIDER and which
 * API keys are configured. Returns 'firecrawl' | 'brave' | 'direct'.
 *
 * Precedence:
 *   - SCRAPER_PROVIDER=firecrawl → firecrawl if FIRECRAWL_API_KEY set, else auto
 *   - SCRAPER_PROVIDER=brave     → brave if BRAVE_API_KEY set, else auto
 *   - auto (default/unset)       → firecrawl if FIRECRAWL_API_KEY, else brave if
 *                                  BRAVE_API_KEY, else direct
 *
 * In `auto`, Firecrawl is preferred over Brave because full-page content yields
 * richer change detection than Brave's snippets.
 */
function resolveScraperProvider() {
  const hasFirecrawl = !!process.env.FIRECRAWL_API_KEY;
  const hasBrave = !!process.env.BRAVE_API_KEY;
  const preference = (process.env.SCRAPER_PROVIDER || 'auto').toLowerCase();

  if (preference === 'firecrawl') {
    if (hasFirecrawl) return 'firecrawl';
    console.warn('SCRAPER_PROVIDER=firecrawl but FIRECRAWL_API_KEY is not set — falling back to auto selection.');
  } else if (preference === 'brave') {
    if (hasBrave) return 'brave';
    console.warn('SCRAPER_PROVIDER=brave but BRAVE_API_KEY is not set — falling back to auto selection.');
  }

  // auto (and the fall-through cases above)
  if (hasFirecrawl) return 'firecrawl';
  if (hasBrave) return 'brave';
  return 'direct';
}

/**
 * Scrape with an explicitly named provider (bypasses auto-resolution).
 * Used when a website opts into specific engines (Firecrawl and/or Brave).
 *
 * @param {'firecrawl'|'brave'|'direct'} provider
 * @param {string} url
 * @param {number} [periodDays=30]
 * @returns {{ contentText: string, source: string, pages: Array }}
 */
async function scrapeWithProvider(provider, url, periodDays = 30) {
  if (provider === 'firecrawl') return scrapeWithFirecrawl(url);
  if (provider === 'brave') return scrapeWithBrave(url, periodDays);
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
  const parsed = await pdfParse(buffer);

  const rawText = (parsed.text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ ]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const info = parsed.info || {};
  const title = info.Title || '';
  const author = info.Author || '';
  const numPages = parsed.numpages || 0;

  const headerLines = [
    `PDF document: ${url}`,
    title ? `Title: ${title}` : null,
    author ? `Author: ${author}` : null,
    numPages ? `Pages: ${numPages}` : null,
    '',
  ].filter((l) => l !== null);

  const contentText = (headerLines.join('\n') + '\n' + rawText).slice(0, MAX_CONTENT_CHARS);

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

/**
 * Maps a monitoring period to a Brave freshness filter.
 *   pw = past week | pm = past month | py = past year
 */
function braveFresnhess(periodDays) {
  if (periodDays <= 7) return 'pw';
  if (periodDays <= 31) return 'pm';
  return 'py';
}

async function scrapeWithBrave(url, periodDays) {
  const domain = extractDomain(url);
  const freshness = braveFresnhess(periodDays);

  // Three parallel searches:
  //  1. Indexed pages on the domain (main content snapshot)
  //  2. News coverage mentioning the domain
  //  3. Announcement / changelog / release pages within the domain
  const [webResults, newsResults, announcementResults] = await Promise.allSettled([
    braveFetch('/web/search', {
      q: `site:${domain}`,
      count: 20,
      freshness,
    }),
    braveFetch('/news/search', {
      q: domain,
      count: 10,
      freshness,
    }),
    braveFetch('/web/search', {
      q: `site:${domain} (blog OR changelog OR "release notes" OR announcement OR "what's new" OR news OR updates)`,
      count: 10,
      freshness,
    }),
  ]);

  const pages = [];

  if (webResults.status === 'fulfilled') {
    const results = webResults.value?.web?.results || [];
    results.forEach((r) => {
      pages.push({
        type: 'web',
        title: r.title || '',
        url: r.url || '',
        description: r.description || '',
        published: r.page_age || r.age || '',
      });
    });
  }

  if (newsResults.status === 'fulfilled') {
    const results = newsResults.value?.results || [];
    results.forEach((r) => {
      pages.push({
        type: 'news',
        title: r.title || '',
        url: r.url || '',
        description: r.description || '',
        published: r.age || r.meta_url?.path || '',
      });
    });
  }

  if (announcementResults.status === 'fulfilled') {
    const results = announcementResults.value?.web?.results || [];
    results.forEach((r) => {
      // Only add if not already present (avoid duplicates)
      if (!pages.some((p) => p.url === r.url)) {
        pages.push({
          type: 'announcement',
          title: r.title || '',
          url: r.url || '',
          description: r.description || '',
          published: r.page_age || r.age || '',
        });
      }
    });
  }

  const contentText = formatBraveContent(url, domain, pages);
  return { contentText: contentText.slice(0, MAX_CONTENT_CHARS), source: 'brave', pages };
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

function formatBraveContent(url, domain, pages) {
  if (pages.length === 0) {
    return `No indexed content found for ${url}`;
  }
  const lines = [`Website: ${url}`, `Domain: ${domain}`, `Indexed pages (${pages.length}):`, ''];
  pages.forEach((p, i) => {
    lines.push(`[${i + 1}] ${p.type.toUpperCase()} | ${p.title}`);
    lines.push(`    URL: ${p.url}`);
    if (p.published) lines.push(`    Published: ${p.published}`);
    if (p.description) lines.push(`    Excerpt: ${p.description}`);
    lines.push('');
  });
  return lines.join('\n');
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
    return {
      contentText: `No content returned by Firecrawl for ${url}`,
      source: 'firecrawl',
      pages: [],
    };
  }

  const header = [
    `Website: ${url}`,
    `Domain: ${domain}`,
    title ? `Title: ${title}` : null,
    description ? `Description: ${description}` : null,
    '',
  ].filter((l) => l !== null).join('\n');

  const contentText = (header + '\n' + md).slice(0, MAX_CONTENT_CHARS);

  const pages = [{
    type: 'page',
    url,
    title: title || url,
    description,
  }];

  return { contentText, source: 'firecrawl', pages };
}

// ---------------------------------------------------------------------------
// Direct fetch fallback (axios + cheerio)
// ---------------------------------------------------------------------------

async function scrapeWithCheerio(url) {
  // Fetch the main page and try to discover update/blog subpages
  const [mainPage, ...subPages] = await Promise.allSettled([
    fetchPage(url),
    ...SUBPATHS_TO_TRY.slice(0, 4).map((path) => fetchPage(buildSubpageUrl(url, path))),
  ]);

  const pages = [];

  if (mainPage.status === 'fulfilled' && mainPage.value) {
    pages.push({ type: 'page', ...mainPage.value });
  }

  for (const sp of subPages) {
    if (sp.status === 'fulfilled' && sp.value) {
      pages.push({ type: 'subpage', ...sp.value });
    }
  }

  if (pages.length === 0) {
    return { contentText: `Failed to fetch content from ${url}`, source: 'direct', pages: [] };
  }

  const contentText = pages
    .map((p) => {
      const lines = [`[${p.type.toUpperCase()}] ${p.title} — ${p.url}`];
      if (p.description) lines.push(`Description: ${p.description}`);
      lines.push('', p.bodyText || '');
      return lines.join('\n');
    })
    .join('\n\n---\n\n');

  return {
    contentText: contentText.slice(0, MAX_CONTENT_CHARS),
    source: 'direct',
    pages: pages.map(({ bodyText: _b, ...rest }) => rest), // strip raw body from page list
  };
}

/**
 * Fetch a single URL and extract clean text.
 * Returns null if the page does not load successfully.
 */
async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; WebMonitor/1.0; +https://github.com/website-monitor)',
      },
      maxRedirects: 5,
    });

    if (!response.data || typeof response.data !== 'string') return null;

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

    const rawText = (contentEl || $('body')).text();
    const bodyText = rawText
      .replace(/\t/g, ' ')
      .replace(/[ ]{3,}/g, '  ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 5000);

    return { url, title, description: metaDesc, bodyText };
  } catch {
    return null;
  }
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

module.exports = { scrapeWebsite, scrapeWithProvider, isPdfUrl, extractDomain, resolveScraperProvider };
