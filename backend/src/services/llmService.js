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

/**
 * Diff budget for a single report call — roughly 7,500 tokens, so an ordinary
 * scan still costs exactly one call while seeing four times the diff the old
 * 6,000-character prompt cut allowed. Only a genuinely large diff pays for the
 * extra condensing passes below.
 */
const DIFF_CHARS_PER_CALL = 30000;

/** Upper bound on condensing passes, so one huge diff cannot run up the bill. */
const MAX_DIFF_CHUNKS = 4;

/** Characters of baseline/current content shown alongside the diff. */
const EXCERPT_CHARS = 6000;

const CHUNK_SYSTEM_PROMPT = `You are extracting facts from part of a website content diff. \
Lines beginning with "+" were added, lines beginning with "-" were removed.

List only what this fragment shows, as short markdown bullets: new or removed pages, \
announcements, releases, product or pricing changes, and policy or terms changes. \
Include any dates that appear. Do not write an introduction, a conclusion, or headings. \
Do not speculate about anything outside the fragment. If the fragment shows nothing of \
substance, reply with exactly: (nothing of substance in this fragment)`;

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
 * @returns {Promise<{ markdown: string, usage: { inputTokens: number, outputTokens: number, model: string } }>}
 *   The report plus the call's token usage, which usage metering records against
 *   the account that triggered the scan.
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
  diffTruncated = false,
  omittedLines = 0,
}) {
  const provider = (process.env.LLM_PROVIDER || 'claude').toLowerCase();
  const call = provider === 'claude' ? callClaude : callOpenAICompatible;

  let diffForPrompt = diffText || '';
  let condensed = false;
  const usages = [];

  // A diff too large for one call is condensed in chunks rather than cut off.
  if (diffForPrompt.length > DIFF_CHARS_PER_CALL) {
    const chunks = splitDiff(diffForPrompt, DIFF_CHARS_PER_CALL, MAX_DIFF_CHUNKS);
    const extracts = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const result = await call(
        `Diff fragment ${i + 1} of ${chunks.length}:\n\n${chunks[i]}`,
        CHUNK_SYSTEM_PROMPT
      );
      usages.push(result.usage);
      const text = result.markdown.trim();
      if (text && !/^\(nothing of substance/i.test(text)) {
        extracts.push(`--- from diff part ${i + 1} of ${chunks.length} ---\n${text}`);
      }
    }

    diffForPrompt = extracts.join('\n\n');
    condensed = true;
  }

  const userMessage = buildAnalysisMessage({
    websiteUrl,
    websiteName,
    periodDays,
    oldContent,
    newContent,
    diffText: diffForPrompt,
    pages,
    isFirstScan,
    diffTruncated,
    omittedLines,
    condensed,
  });

  const final = await call(userMessage, SYSTEM_PROMPT);
  usages.push(final.usage);

  return { markdown: final.markdown, usage: mergeUsage(usages) };
}

/**
 * Split a diff into at most `maxChunks` pieces on line boundaries.
 * Whatever does not fit is dropped, but the caller still declares the
 * truncation in the prompt — it is never passed off as a complete diff.
 */
function splitDiff(diffText, chunkChars, maxChunks) {
  const chunks = [];
  let current = [];
  let used = 0;

  for (const line of diffText.split('\n')) {
    if (used + line.length + 1 > chunkChars && current.length) {
      chunks.push(current.join('\n'));
      if (chunks.length === maxChunks) return chunks;
      current = [];
      used = 0;
    }
    current.push(line);
    used += line.length + 1;
  }

  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

/** Sum the token usage of every call made for one report. */
function mergeUsage(usages) {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u?.inputTokens || 0),
      outputTokens: acc.outputTokens + (u?.outputTokens || 0),
      model: u?.model || acc.model,
    }),
    { inputTokens: 0, outputTokens: 0, model: '' }
  );
}

/** Milliseconds before an LLM call is abandoned. */
function requestTimeoutMs() {
  const configured = parseInt(process.env.LLM_TIMEOUT_MS, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 120_000;
}

const EMPTY_ANALYSIS = '## Executive Summary\n\nNo analysis generated.';

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

async function callClaude(userMessage, systemPrompt = SYSTEM_PROMPT) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: requestTimeoutMs(),
  });
  const model = process.env.LLM_MODEL || DEFAULT_CLAUDE_MODEL;

  const message = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return {
    markdown: message.content[0]?.text || EMPTY_ANALYSIS,
    usage: {
      inputTokens: message.usage?.input_tokens || 0,
      outputTokens: message.usage?.output_tokens || 0,
      model,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, Ollama, LM Studio, Groq, Together, Mistral, …)
// ---------------------------------------------------------------------------

async function callOpenAICompatible(userMessage, systemPrompt = SYSTEM_PROMPT) {
  const OpenAI = require('openai');

  const clientOptions = {
    apiKey: process.env.OPENAI_API_KEY || 'no-key-required',
    timeout: requestTimeoutMs(),
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
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return {
    markdown: completion.choices[0]?.message?.content || EMPTY_ANALYSIS,
    usage: {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      model,
    },
  };
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
  diffTruncated = false,
  omittedLines = 0,
  condensed = false,
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
  //
  // Passed through whole. It used to be re-cut to 6,000 characters here, on top
  // of the cap diffService had already applied, with nothing telling the model
  // that it was looking at a partial account of the changes.
  if (diffText) {
    parts.push(
      condensed
        ? `=== CONTENT DIFF (condensed: the diff was too large for one pass, so each part was summarised first) ===`
        : `=== CONTENT DIFF (lines added/removed since baseline) ===`
    );
    parts.push(diffText);
    if (diffTruncated) {
      parts.push(
        `NOTE: this diff is incomplete — ${omittedLines} further changed line${omittedLines === 1 ? '' : 's'} ` +
          `could not be included. Say in the Executive Summary that some changes could not be reviewed.`
      );
    }
    parts.push('');
  }

  // ── Baseline content (comparison anchor) ──
  if (oldContent && !isFirstScan) {
    parts.push(`=== BASELINE CONTENT (from ~${periodDays} day${periodDays === 1 ? '' : 's'} ago, first ${EXCERPT_CHARS} chars) ===`);
    parts.push(oldContent.slice(0, EXCERPT_CHARS));
    parts.push('');
  }

  // ── Current content ──
  parts.push(`=== CURRENT CONTENT (first ${EXCERPT_CHARS} chars) ===`);
  parts.push(newContent.slice(0, EXCERPT_CHARS));
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
