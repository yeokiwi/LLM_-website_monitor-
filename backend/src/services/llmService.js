/**
 * LLM Service — abstraction over Claude (Anthropic) and OpenAI.
 *
 * Configured via:
 *   LLM_PROVIDER=claude  (default) → ANTHROPIC_API_KEY
 *   LLM_PROVIDER=openai            → OPENAI_API_KEY
 */

const SYSTEM_PROMPT = `You are a website change analyst. You receive the old and new indexed content \
of a website, along with a diff summary showing what was added or removed. \
Your job is to produce a clear, concise summary of what has changed on the website.

Focus on:
- New pages, articles, or announcements that appeared
- Content that was removed or significantly altered
- Any notable updates (product changes, news, events, pricing, features)
- Overall tone/direction shifts if apparent

Be factual and concise. Use bullet points where helpful. \
If there are no meaningful changes, say so clearly. Do not speculate beyond what the diff shows.`;

/**
 * @param {object} params
 * @param {string} params.websiteUrl
 * @param {number} params.periodDays
 * @param {string} params.oldContent
 * @param {string} params.newContent
 * @param {string} params.diffText
 * @returns {Promise<string>} LLM summary
 */
async function summarizeChanges({ websiteUrl, periodDays, oldContent, newContent, diffText }) {
  const provider = (process.env.LLM_PROVIDER || 'claude').toLowerCase();

  const userMessage = buildUserMessage({ websiteUrl, periodDays, oldContent, newContent, diffText });

  if (provider === 'openai') {
    return summarizeWithOpenAI(userMessage);
  }
  return summarizeWithClaude(userMessage);
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

async function summarizeWithClaude(userMessage) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  return message.content[0]?.text || 'No summary generated.';
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function summarizeWithOpenAI(userMessage) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const completion = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  return completion.choices[0]?.message?.content || 'No summary generated.';
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function buildUserMessage({ websiteUrl, periodDays, oldContent, newContent, diffText }) {
  return [
    `Website: ${websiteUrl}`,
    `Monitoring period: last ${periodDays} day(s)`,
    ``,
    `=== OLD CONTENT (baseline from ~${periodDays} days ago) ===`,
    oldContent.slice(0, 4000),
    ``,
    `=== NEW CONTENT (current) ===`,
    newContent.slice(0, 4000),
    ``,
    diffText ? diffText : '(No structured diff available)',
    ``,
    `Please summarize what has changed on this website over the past ${periodDays} day(s).`,
  ].join('\n');
}

module.exports = { summarizeChanges };
