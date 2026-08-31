/**
 * Scan orchestration.
 *
 * Previously this lived inside routes/scans.js. It is a service now because the
 * scheduler runs exactly the same code path — a scheduled scan and a manual one
 * must consume the same quota, record the same usage, and produce the same
 * report, which only holds if there is one implementation.
 *
 * This is the single place in the product where money is spent: every scraper
 * call and every LLM completion originates below. Usage metering therefore
 * lives here rather than in the route.
 */

const db = require('../db');
const { scrapeWithProvider, scrapePdf, isPdfUrl } = require('./scraper');
const {
  saveSnapshot,
  findBaselineSnapshot,
  getPreviousSnapshot,
} = require('./snapshotService');
const { computeDiff } = require('./diffService');
const { summarizeChanges } = require('./llmService');
const entitlements = require('./entitlements');
const scanRepo = require('../repositories/scanRepo');
const usageRepo = require('../repositories/usageRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');

const PROVIDER_SECTION_LABELS = {
  firecrawl: 'Firecrawl Results',
  brave: 'Brave Search Results',
  serper: 'Serper Search Results',
  direct: 'Direct Scrape Results',
};

const PROVIDER_SHORT_LABELS = {
  firecrawl: 'Firecrawl',
  brave: 'Brave',
  serper: 'Serper',
  direct: 'Direct',
};

/**
 * Upstream requests each engine makes for one scrape. Brave and Serper each
 * issue three searches (web, news, announcements); Firecrawl one page fetch;
 * the direct scraper fetches the main page plus four guessed subpaths.
 */
const SCRAPE_CALLS_PER_PROVIDER = {
  firecrawl: 1,
  brave: 3,
  serper: 3,
  direct: 5,
  pdf: 1,
};

/** Accumulates what one scan spent, so it can be metered in a single write. */
function newCostLedger() {
  return { llmCalls: 0, scrapeCalls: 0, inputTokens: 0, outputTokens: 0 };
}

function recordLlm(ledger, usage) {
  ledger.llmCalls += 1;
  ledger.inputTokens += usage?.inputTokens || 0;
  ledger.outputTokens += usage?.outputTokens || 0;
}

function recordScrape(ledger, provider) {
  ledger.scrapeCalls += SCRAPE_CALLS_PER_PROVIDER[provider] || 1;
}

/**
 * The engines to run for a website: the ones it opted into, intersected with
 * the ones the owner's plan permits and the deployment has keys for.
 *
 * A plan restriction silently downgrades rather than erroring — a Free user who
 * imported a spreadsheet with `use_firecrawl=1` gets a direct scrape, not a
 * failed scan and not a surprise Firecrawl bill.
 */
function resolveProviders(website, ownerId) {
  const allowed = new Set(entitlements.allowedEngines(ownerId));

  const providers = [];
  if (website.use_firecrawl && allowed.has('firecrawl')) providers.push('firecrawl');
  if (website.use_brave && allowed.has('brave')) providers.push('brave');
  if (website.use_serper && allowed.has('serper')) providers.push('serper');

  if (providers.length === 0) return { providers: ['direct'], usingFallback: true };
  return { providers, usingFallback: false };
}

/** Scrape, snapshot, diff and summarise one website with one engine. */
async function scanOneProvider(website, periodDays, provider, ledger) {
  const { contentText, pages } = await scrapeWithProvider(provider, website.url, periodDays);
  recordScrape(ledger, provider);

  const snap = saveSnapshot(website.id, contentText, provider);
  const baseline = findBaselineSnapshot(website.id, periodDays, provider);

  // First scan for this engine — no history yet.
  if (!baseline || baseline.id === snap.id) {
    const { markdown, usage } = await summarizeChanges({
      websiteUrl: website.url,
      websiteName: website.name,
      periodDays,
      oldContent: '',
      newContent: contentText,
      diffText: '',
      pages,
      isFirstScan: true,
    });
    recordLlm(ledger, usage);

    return {
      status: 'no_history',
      markdown,
      newSnapshotId: snap.id,
      oldSnapshotId: null,
      diffSummary: null,
    };
  }

  const { diffText, hasChanges, addedLines, removedLines } = computeDiff(
    baseline.content_text,
    contentText
  );

  // No changes means no LLM call — the only cost short-circuit in the system.
  if (!hasChanges) {
    return {
      status: 'no_changes',
      markdown: `No changes detected over the past ${periodDays} day(s).`,
      newSnapshotId: snap.id,
      oldSnapshotId: baseline.id,
      diffSummary: null,
    };
  }

  const { markdown, usage } = await summarizeChanges({
    websiteUrl: website.url,
    websiteName: website.name,
    periodDays,
    oldContent: baseline.content_text,
    newContent: contentText,
    diffText,
    pages,
    isFirstScan: false,
  });
  recordLlm(ledger, usage);

  return {
    status: 'completed',
    markdown,
    newSnapshotId: snap.id,
    oldSnapshotId: baseline.id,
    diffSummary: `+${addedLines}/-${removedLines}`,
  };
}

/**
 * Persist a scan result and charge the owner's usage counters in one
 * transaction, so a crash can never bill for a scan that was not recorded (or
 * record one that was not billed).
 */
function commitScan(ownerId, fields, ledger) {
  const subscription = subscriptionRepo.findLiveForUser(ownerId);
  const window = usageRepo.currentWindow(subscription);

  const commit = db.transaction(() => {
    const scanId = scanRepo.create(fields);

    usageRepo.increment(ownerId, window, {
      scans_used: 1,
      llm_calls: ledger.llmCalls,
      scrape_calls: ledger.scrapeCalls,
      input_tokens: ledger.inputTokens,
      output_tokens: ledger.outputTokens,
    });

    return scanId;
  });

  return commit();
}

/**
 * Scan one website.
 *
 * @param {object} website           row from websiteRepo (must include owner_id)
 * @param {number} periodDays        lookback window for the baseline snapshot
 * @param {'manual'|'schedule'} triggeredBy
 */
async function runSingleScan(website, periodDays, triggeredBy = 'manual') {
  const startedAt = Date.now();
  const ownerId = website.owner_id;
  const ledger = newCostLedger();

  // PDFs are scanned as documents (search engines bypassed) and diffed against
  // the previous scan rather than the period baseline.
  let pdf = false;
  try {
    pdf = await isPdfUrl(website.url);
  } catch {
    /* treat as non-PDF */
  }
  if (pdf) {
    return runPdfScan(website, periodDays, triggeredBy, ledger, startedAt);
  }

  const { providers, usingFallback } = resolveProviders(website, ownerId);

  const sections = [];
  const statuses = [];
  const diffParts = [];
  let primaryNewSnapshotId = null;
  let primaryOldSnapshotId = null;
  let lastError = null;

  for (const provider of providers) {
    let body;
    let status;
    try {
      const r = await scanOneProvider(website, periodDays, provider, ledger);
      body = r.markdown;
      status = r.status;
      if (primaryNewSnapshotId === null) {
        primaryNewSnapshotId = r.newSnapshotId;
        primaryOldSnapshotId = r.oldSnapshotId;
      }
      if (r.diffSummary) diffParts.push(`${PROVIDER_SHORT_LABELS[provider]}: ${r.diffSummary}`);
    } catch (err) {
      console.error(`Scan failed for ${website.url} [${provider}]:`, err.message);
      body = `**Error:** ${err.message}`;
      status = 'error';
      lastError = err;
    }
    statuses.push(status);
    sections.push(usingFallback ? body : `# ${PROVIDER_SECTION_LABELS[provider]}\n\n${body}`);
  }

  const combined = sections.join('\n\n');

  // Aggregate the per-engine outcomes into one row-level status.
  let status;
  if (statuses.includes('completed')) status = 'completed';
  else if (statuses.includes('no_history')) status = 'no_history';
  else if (statuses.every((st) => st === 'no_changes')) status = 'no_changes';
  else status = 'error';

  // Every engine failed before saving a snapshot, so there is no snapshot to
  // reference and no row to write (new_snapshot_id is NOT NULL). Usage is not
  // charged either — nothing usable was produced.
  if (primaryNewSnapshotId === null) {
    return {
      scanId: null,
      websiteId: website.id,
      url: website.url,
      status: 'error',
      error: lastError ? lastError.message : 'Scan failed',
    };
  }

  const diffSummary = diffParts.length ? diffParts.join(' · ') : null;

  const scanId = commitScan(
    ownerId,
    {
      website_id: website.id,
      owner_id: ownerId,
      period_days: periodDays,
      old_snapshot_id: primaryOldSnapshotId,
      new_snapshot_id: primaryNewSnapshotId,
      diff_summary: diffSummary,
      llm_summary: combined,
      status,
      triggered_by: triggeredBy,
      engines_used: providers.join('+'),
      llm_input_tokens: ledger.inputTokens,
      llm_output_tokens: ledger.outputTokens,
      duration_ms: Date.now() - startedAt,
    },
    ledger
  );

  return {
    scanId,
    websiteId: website.id,
    url: website.url,
    status,
    llm_summary: combined,
    diff_summary: diffSummary,
    source: providers.join('+'),
  };
}

/**
 * PDF scan — the URL points to a PDF document. Only the document text is
 * scanned, and it is compared against the previous scan's snapshot so the
 * report reflects changes since the last scan.
 */
async function runPdfScan(website, periodDays, triggeredBy, ledger, startedAt) {
  const ownerId = website.owner_id;
  let newSnapshot = null;

  const baseFields = {
    website_id: website.id,
    owner_id: ownerId,
    period_days: periodDays,
    triggered_by: triggeredBy,
    engines_used: 'pdf',
  };

  try {
    const { contentText, source, pages } = await scrapePdf(website.url);
    recordScrape(ledger, 'pdf');

    newSnapshot = saveSnapshot(website.id, contentText, 'pdf');

    const oldSnapshot = getPreviousSnapshot(website.id, newSnapshot.id, 'pdf');

    if (!oldSnapshot) {
      const { markdown, usage } = await summarizeChanges({
        websiteUrl: website.url,
        websiteName: website.name,
        periodDays,
        oldContent: '',
        newContent: contentText,
        diffText: '',
        pages,
        isFirstScan: true,
      });
      recordLlm(ledger, usage);

      const scanId = commitScan(
        ownerId,
        {
          ...baseFields,
          new_snapshot_id: newSnapshot.id,
          status: 'no_history',
          llm_summary: markdown,
          llm_input_tokens: ledger.inputTokens,
          llm_output_tokens: ledger.outputTokens,
          duration_ms: Date.now() - startedAt,
        },
        ledger
      );

      return {
        scanId,
        websiteId: website.id,
        url: website.url,
        status: 'no_history',
        llm_summary: markdown,
        source,
      };
    }

    const { diffText, hasChanges, addedLines, removedLines } = computeDiff(
      oldSnapshot.content_text,
      contentText
    );

    if (!hasChanges) {
      const summary = `No changes detected in the PDF at ${website.url} since the last scan.`;
      const scanId = commitScan(
        ownerId,
        {
          ...baseFields,
          old_snapshot_id: oldSnapshot.id,
          new_snapshot_id: newSnapshot.id,
          status: 'no_changes',
          llm_summary: summary,
          duration_ms: Date.now() - startedAt,
        },
        ledger
      );

      return {
        scanId,
        websiteId: website.id,
        url: website.url,
        status: 'no_changes',
        source,
      };
    }

    const { markdown, usage } = await summarizeChanges({
      websiteUrl: website.url,
      websiteName: website.name,
      periodDays,
      oldContent: oldSnapshot.content_text,
      newContent: contentText,
      diffText,
      pages,
      isFirstScan: false,
    });
    recordLlm(ledger, usage);

    const diffSummary = `+${addedLines} lines / -${removedLines} lines`;

    const scanId = commitScan(
      ownerId,
      {
        ...baseFields,
        old_snapshot_id: oldSnapshot.id,
        new_snapshot_id: newSnapshot.id,
        diff_summary: diffSummary,
        llm_summary: markdown,
        status: 'completed',
        llm_input_tokens: ledger.inputTokens,
        llm_output_tokens: ledger.outputTokens,
        duration_ms: Date.now() - startedAt,
      },
      ledger
    );

    return {
      scanId,
      websiteId: website.id,
      url: website.url,
      status: 'completed',
      llm_summary: markdown,
      diff_summary: diffSummary,
      source,
    };
  } catch (err) {
    console.error(`Scan failed for ${website.url}:`, err.message);

    let scanId = null;
    if (newSnapshot) {
      scanId = commitScan(
        ownerId,
        {
          ...baseFields,
          new_snapshot_id: newSnapshot.id,
          status: 'error',
          error_message: err.message,
          duration_ms: Date.now() - startedAt,
        },
        ledger
      );
    }

    return {
      scanId,
      websiteId: website.id,
      url: website.url,
      status: 'error',
      error: err.message,
    };
  }
}

module.exports = {
  runSingleScan,
  resolveProviders,
  SCRAPE_CALLS_PER_PROVIDER,
};
