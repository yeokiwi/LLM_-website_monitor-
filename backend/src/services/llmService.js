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

// Default models per provider family
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

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

  if (provider === 'claude') {
    return summarizeWithClaude(userMessage);
  }
  return summarizeWithOpenAICompatible(userMessage);
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

async function summarizeWithClaude(userMessage) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.LLM_MODEL || DEFAULT_CLAUDE_MODEL;

  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  return message.content[0]?.text || 'No summary generated.';
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, Ollama, LM Studio, Groq, Together, Mistral, …)
// ---------------------------------------------------------------------------

async function summarizeWithOpenAICompatible(userMessage) {
  const OpenAI = require('openai');

  const clientOptions = {
    apiKey: process.env.OPENAI_API_KEY || 'no-key-required',
  };

  // Allow any OpenAI-compatible base URL
  if (process.env.OPENAI_BASE_URL) {
    clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  }

  const client = new OpenAI(clientOptions);
  const model = process.env.LLM_MODEL || DEFAULT_OPENAI_MODEL;

  const completion = await client.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  return completion.choices[0]?.message?.content || 'No summary generated.';
}

/**
 * Return a display string describing the active LLM configuration.
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

module.exports = { summarizeChanges, getLLMInfo };
