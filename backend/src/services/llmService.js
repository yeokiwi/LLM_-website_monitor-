/**
 * LLM Service
 *
 * Two modes:
 *   LLM_PROVIDER=claude   → Anthropic SDK  (ANTHROPIC_API_KEY, LLM_MODEL)
 *   LLM_PROVIDER=<other>  → OpenAI-compatible SDK (OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL)
 *
 * OpenAI-compatible providers (set OPENAI_BASE_URL accordingly):
 *   OpenAI        https://api.openai.com/v1          (default, no base URL needed)
 *   Azure OpenAI  https://<resource>.openai.azure.com/openai/deployments/<deploy>
 *   Ollama        http://localhost:11434/v1
 *   LM Studio     http://localhost:1234/v1
 *   Groq          https://api.groq.com/openai/v1
 *   Together AI   https://api.together.xyz/v1
 *   Mistral AI    https://api.mistral.ai/v1
 *   Perplexity    https://api.perplexity.ai
 *   DeepSeek      https://api.deepseek.com/v1
 *   (any other OpenAI-compatible endpoint)
 */

// ---------------------------------------------------------------------------
// System prompt — structured markdown change report
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a professional website change analyst. You produce structured markdown \
change reports for monitored websites.

You receive scraped website content — search-indexed pages with titles, URLs, excerpts, and publication \
dates — along with (when available) a content diff showing exactly what changed since the baseline.

Your output MUST follow this EXACT structure (use ## for each of these six headings):

---

## Executive Summary

2–3 sentences giving an overall picture. Note if source data is sparse.

## What's New or Changed

Bullet list of the most notable changes or additions. Use **bold** for product/feature names. \
Include dates when available (e.g., "**March 2026** — Feature X launched"). \
If nothing found: "Nothing detected for this period."

## Announcements & New Releases

Press releases, product launches, version releases, blog posts, or official announcements. \
Format each as: "- **[Date if known] — [Title]:** description". \
If nothing found: "Nothing detected for this period."

## Product, Service & Feature Updates

Changes to products, services, pricing, or features. \
If nothing found: "Nothing detected for this period."

## Policy & Terms Changes

Changes to terms of service, privacy policy, cookie policy, pricing structures, or legal documents. \
If nothing found: "Nothing detected for this period."

## Confidence Assessment

**Confirmed recent** (explicit dates found within the monitoring period):
- List items with confirmed dates here, or "None identified."

**Appears recent** (contextually inferred — no explicit date, likely recent based on context or ordering):
- List items here, or "None identified."

---

RULES:
- Be factual. Only report what the source data shows. Never invent or speculate.
- Use clean markdown: bullets with \`-\`, bold with \`**\`, no HTML tags.
- Use \`##\` for the six main headings above — do not change their wording.
- Always include dates when they appear in the source material.
- If a section has nothing to report, write exactly: "Nothing detected for this period."`;

// Default models per provider family
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

// Maximum tokens for structured reports
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a structured markdown change report.
 *
 * @param {object} params
 * @param {string} params.websiteUrl
 * @param {string} [params.websiteName]
 * @param {number} params.periodDays
 * @param {string} params.oldContent         — baseline snapshot text (empty string for first scans)
 * @param {string} params.newContent         — current snapshot text
 * @param {string} [params.diffText]         — line diff from diffService
 * @param {Array}  [params.pages]            — structured page list from scraper
 * @param {boolean} [params.isFirstScan]     — true when no historical baseline exists
 * @returns {Promise<string>} markdown report
 */
async function summarizeChanges({
  websiteUrl,
  websiteName,
  periodDays,
  oldContent,
  newContent,
  diffText,
  pages,
  isFirstScan = false,
}) {
  const provider = (process.env.LLM_PROVIDER || 'claude').toLowerCase();
  const userMessage = buildAnalysisMessage({
    websiteUrl,
    websiteName,
    periodDays,
    oldContent,
    newContent,
    diffText,
    pages,
    isFirstScan,
  });

  if (provider === 'claude') {
    return callClaude(userMessage);
  }
  return callOpenAICompatible(userMessage);
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

async function callClaude(userMessage) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.LLM_MODEL || DEFAULT_CLAUDE_MODEL;

  const message = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  return message.content[0]?.text || '## Executive Summary\n\nNo analysis generated.';
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, Ollama, LM Studio, Groq, Together, Mistral, …)
// ---------------------------------------------------------------------------

async function callOpenAICompatible(userMessage) {
  const OpenAI = require('openai');

  const clientOptions = {
    apiKey: process.env.OPENAI_API_KEY || 'no-key-required',
  };

  if (process.env.OPENAI_BASE_URL) {
    clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  }

  const client = new OpenAI(clientOptions);
  const model = process.env.LLM_MODEL || DEFAULT_OPENAI_MODEL;

  const completion = await client.chat.completions.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  return completion.choices[0]?.message?.content || '## Executive Summary\n\nNo analysis generated.';
}

// ---------------------------------------------------------------------------
// Helper — build the user message with all available context
// ---------------------------------------------------------------------------

function buildAnalysisMessage({
  websiteUrl,
  websiteName,
  periodDays,
  oldContent,
  newContent,
  diffText,
  pages,
  isFirstScan,
}) {
  const today = new Date().toISOString().split('T')[0];
  const periodStart = new Date(Date.now() - periodDays * 86_400_000).toISOString().split('T')[0];
  const siteLabel = websiteName ? `${websiteName} (${websiteUrl})` : websiteUrl;

  const parts = [
    `Website: ${siteLabel}`,
    `Monitoring period: ${periodStart} to ${today} (last ${periodDays} day${periodDays === 1 ? '' : 's'})`,
    isFirstScan
      ? 'Note: This is the FIRST scan. No historical baseline is available for comparison. Analyse the current indexed content to identify what appears to be recent activity within the period.'
      : '',
    '',
  ].filter((l) => l !== undefined);

  // ── Indexed pages (from scraper) ──
  if (pages && pages.length > 0) {
    parts.push(`=== INDEXED PAGES & CONTENT (${pages.length} items) ===`);
    pages.slice(0, 40).forEach((p, i) => {
      parts.push(`[${i + 1}] ${(p.type || 'PAGE').toUpperCase()} | ${p.title || '(no title)'}`);
      if (p.url) parts.push(`    URL: ${p.url}`);
      if (p.published) parts.push(`    Date: ${p.published}`);
      if (p.description) parts.push(`    Excerpt: ${p.description}`);
      parts.push('');
    });
  }

  // ── Content diff (when available) ──
  if (diffText && (diffText.includes('+') || diffText.includes('-'))) {
    parts.push(`=== CONTENT DIFF (lines added/removed since baseline) ===`);
    parts.push(diffText.slice(0, 6000));
    parts.push('');
  }

  // ── Baseline content (comparison anchor) ──
  if (oldContent && !isFirstScan) {
    parts.push(`=== BASELINE CONTENT (from ~${periodDays} day${periodDays === 1 ? '' : 's'} ago, first 2500 chars) ===`);
    parts.push(oldContent.slice(0, 2500));
    parts.push('');
  }

  // ── Current content ──
  parts.push(`=== CURRENT CONTENT (first 2500 chars) ===`);
  parts.push(newContent.slice(0, 2500));
  parts.push('');

  parts.push(
    isFirstScan
      ? `Please produce a structured markdown change report for this website. Focus on what appears to have happened in the last ${periodDays} day${periodDays === 1 ? '' : 's'} based on the indexed content above.`
      : `Please produce a structured markdown change report covering what changed on this website over the past ${periodDays} day${periodDays === 1 ? '' : 's'}.`
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Return a display object describing the active LLM configuration.
 */
function getLLMInfo() {
  const provider = (process.env.LLM_PROVIDER || 'claude').toLowerCase();
  if (provider === 'claude') {
    return {
      provider: 'claude',
      model: process.env.LLM_MODEL || DEFAULT_CLAUDE_MODEL,
      baseUrl: 'https://api.anthropic.com',
    };
  }
  return {
    provider,
    model: process.env.LLM_MODEL || DEFAULT_OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  };
}

module.exports = { summarizeChanges, getLLMInfo };
