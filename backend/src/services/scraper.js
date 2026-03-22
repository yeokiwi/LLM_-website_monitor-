/**
 * Scraper service
 *
 * Primary:  Brave Search API  — uses indexed, clean page content/snippets
 * Fallback: axios + cheerio  — direct HTML fetch + text extraction
 *
 * BRAVE_API_KEY env var determines which method is used.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1';
const MAX_CONTENT_CHARS = 12000; // truncate before storing / sending to LLM

/**
 * Scrape a website and return structured content.
 * @param {string} url
 * @returns {{ contentText: string, source: 'brave'|'direct', pages: Array }}
 */
async function scrapeWebsite(url) {
  if (process.env.BRAVE_API_KEY) {
    return scrapeWithBrave(url);
  }
  return scrapeWithCheerio(url);
}

// ---------------------------------------------------------------------------
// Brave Search API
// ---------------------------------------------------------------------------

async function scrapeWithBrave(url) {
  const domain = extractDomain(url);
  const query = `site:${domain}`;

  // Fetch web search results for the domain
  const [webResults, newsResults] = await Promise.allSettled([
    braveFetch('/web/search', { q: query, count: 20, freshness: 'py' }),
    braveFetch('/news/search', { q: domain, count: 10, freshness: 'py' }),
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
    if (p.description) lines.push(`    Summary: ${p.description}`);
    lines.push('');
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Direct fetch fallback (axios + cheerio)
// ---------------------------------------------------------------------------

async function scrapeWithCheerio(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; WebMonitor/1.0; +https://github.com/website-monitor)',
    },
    maxRedirects: 5,
  });

  const $ = cheerio.load(response.data);

  // Remove noise
  $('script, style, noscript, svg, iframe, nav, footer, [role="banner"]').remove();

  const title = $('title').text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';

  // Extract main content
  const contentSelectors = ['main', 'article', '[role="main"]', '#content', '.content', 'body'];
  let contentEl = null;
  for (const sel of contentSelectors) {
    if ($(sel).length) {
      contentEl = $(sel).first();
      break;
    }
  }

  const rawText = contentEl
    ? contentEl.text()
    : $('body').text();

  const cleanText = rawText
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const contentText = [
    `Website: ${url}`,
    `Title: ${title}`,
    metaDesc ? `Description: ${metaDesc}` : '',
    '',
    cleanText,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    contentText: contentText.slice(0, MAX_CONTENT_CHARS),
    source: 'direct',
    pages: [{ type: 'page', title, url, description: metaDesc }],
  };
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

module.exports = { scrapeWebsite, extractDomain };
