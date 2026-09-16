/**
 * Scan orchestration.
 *
 * Previously this lived inside routes/scans.js. It is a service now because the
 * scheduler runs exactly the same code path — a scheduled scan and a manual one
 * must record the same usage and produce the same report, which only holds if
 * there is one implementation.
 *
 * This is the single place in the product where money is spent: every scraper
 * call and every LLM completion originates below, and the per-scan token and
 * duration figures recorded here are what make that spend visible.
 */

const db = require('../db');
const { scrapeWithProvider, scrapePdf, isPdfUrl, availableEngines } = require('./scraper');
const {
  saveSnapshot,
  snapshotText,
  findBaselineSnapshot,
  getPreviousSnapshot,
} = require('./snapshotService');
const { computeDiff } = require('./diffService');
const { summarizeChanges } = require('./llmService');
const scanRepo = require('../repositories/scanRepo');

const PROVIDER_SECTION_LABELS = {
  firecrawl: 'Firecrawl Results',
  brave: 'Related News & Announcements (Brave — supplementary)',
  serper: 'Related News & Announcements (Serper — supplementary)',
  direct: 'Direct Scrape Results',
};

/**
 * What each engine is for.
 *
 * `detector` engines read the monitored page itself and decide whether it
 * changed. `supplementary` engines are search APIs: they surface related news
 * and announcements, but they see the search index rather than the page, so
 * their results are context, not a verdict. Their outcome is reported but never
 * sets the row status — otherwise a reshuffled result list reads as a change to
 * the page, and every URL on a shared host reports the same thing.
 */
const PROVIDER_ROLES = {
  firecrawl: 'detector',
  direct: 'detector',
  pdf: 'detector',
  brave: 'supplementary',
  serper: 'supplementary',
};

const isDetector = (provider) => PROVIDER_ROLES[provider] === 'detector';

const PROVIDER_SHORT_LABELS = {
  firecrawl: 'Firecrawl',
  brave: 'Brave',
  serper: 'Serper',
  direct: 'Direct',
};

/**
 * Accumulates the LLM tokens one scan spent, so they can be written onto the
 * scan row it produced. That row is the only cost record the product keeps.
 */
function newCostLedger() {
  return { inputTokens: 0, outputTokens: 0 };
}

function recordLlm(ledger, usage) {
  ledger.inputTokens += usage?.inputTokens || 0;
  ledger.outputTokens += usage?.outputTokens || 0;
}

/**
 * The engines to run for a website: the ones it opted into, intersected with
 * the ones this deployment holds API keys for.
 *
 * A missing key silently downgrades rather than erroring — a spreadsheet
 * imported with `use_firecrawl=1` onto a deployment with no Firecrawl key gets
 * a direct scrape, not a failed scan.
 */
function resolveProviders(website, ownerId) {
  const allowed = new Set(availableEngines(['firecrawl', 'brave', 'serper']));

  const providers = [];
  if (website.use_firecrawl && allowed.has('firecrawl')) providers.push('firecrawl');
  if (website.use_brave && allowed.has('brave')) providers.push('brave');
  if (website.use_serper && allowed.has('serper')) providers.push('serper');

  if (providers.length === 0) return { providers: ['direct'], usingFallback: true };

  // A website configured with search engines only has nothing actually reading
  // the page, so add the direct scraper as its change detector. Without this a
  // Brave-only site would have its verdict decided by domain-wide search hits.
  if (!providers.some(isDetector)) providers.unshift('direct');

  return { providers, usingFallback: false };
}

/** Scrape, snapshot, diff and summarise one website with one engine. */
async function scanOneProvider(website, periodDays, provider, ledger) {
  const { contentText, pages, notes } = await scrapeWithProvider(provider, website.url, periodDays);

  const snap = saveSnapshot(website.id, contentText, provider);
  const baseline = findBaselineSnapshot(website.id, periodDays, provider, snap.id);
  const footnotes = (notes || []).length ? `\n\n_${notes.join('. ')}._` : '';

  // No eligible history for this engine: either a genuinely first scan, or the
  // only earlier snapshots predate the current content format (see
  // snapshotService.FORMAT_VERSION) and would diff as wholesale change.
  if (!baseline) {
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
      markdown: markdown + footnotes,
      newSnapshotId: snap.id,
      oldSnapshotId: null,
      diffSummary: null,
    };
  }

  const baselineText = snapshotText(baseline);
  const { diffText, hasChanges, addedLines, removedLines, truncated, omittedLines } = computeDiff(
    baselineText,
    contentText
  );

  // No changes means no LLM call — the only cost short-circuit in the system.
  if (!hasChanges) {
    return {
      status: 'no_changes',
      markdown: `No changes detected over the past ${periodDays} day(s).${footnotes}`,
      newSnapshotId: snap.id,
      oldSnapshotId: baseline.id,
      diffSummary: null,
    };
  }

  const { markdown, usage } = await summarizeChanges({
    websiteUrl: website.url,
    websiteName: website.name,
    periodDays,
    oldContent: baselineText,
    newContent: contentText,
    diffText,
    pages,
    isFirstScan: false,
    diffTruncated: truncated,
    omittedLines,
  });
  recordLlm(ledger, usage);

  return {
    status: 'completed',
    markdown: markdown + footnotes,
    newSnapshotId: snap.id,
    oldSnapshotId: baseline.id,
    diffSummary: `+${addedLines}/-${removedLines}`,
  };
}

/**
 * Persist a scan result.
 *
 * Still a transaction, and still the one place a scan row is written, so the
 * per-scan cost figures in `fields` (token counts, duration) land atomically
 * with the result they describe.
 */
function commitScan(fields) {
  return db.transaction(() => scanRepo.create(fields))();
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
  const engineStatuses = {};
  const engineErrors = [];
  const diffParts = [];
  let primaryNewSnapshotId = null;
  let primaryOldSnapshotId = null;
  let primaryIsDetector = false;
  let lastError = null;

  for (const provider of providers) {
    let body;
    let status;
    try {
      const r = await scanOneProvider(website, periodDays, provider, ledger);
      body = r.markdown;
      status = r.status;

      // Prefer a detector's snapshots as the row's diff anchor — those are the
      // ones that read the monitored page.
      const detector = isDetector(provider);
      if (primaryNewSnapshotId === null || (detector && !primaryIsDetector)) {
        primaryNewSnapshotId = r.newSnapshotId;
        primaryOldSnapshotId = r.oldSnapshotId;
        primaryIsDetector = detector;
      }
      if (r.diffSummary) diffParts.push(`${PROVIDER_SHORT_LABELS[provider]}: ${r.diffSummary}`);
    } catch (err) {
      console.error(`Scan failed for ${website.url} [${provider}]:`, err.message);
      body = `**Error:** ${err.message}`;
      status = 'error';
      engineErrors.push(`${PROVIDER_SHORT_LABELS[provider]}: ${err.message}`);
      lastError = err;
    }
    engineStatuses[provider] = status;
    sections.push(usingFallback ? body : `# ${PROVIDER_SECTION_LABELS[provider]}\n\n${body}`);
  }

  const combined = sections.join('\n\n');

  // Aggregate the per-engine outcomes into one row-level status.
  //
  // The verdict — changed, unchanged, no history — comes only from detector
  // engines: a search engine sees the index, not the page, so a reshuffled
  // result list must not read as a change to the monitored page. When every
  // detector failed but a search engine succeeded, the search results are all
  // we have, so they decide rather than reporting nothing at all.
  const detectors = providers.filter(isDetector);
  const voting = detectors.some((pr) => engineStatuses[pr] !== 'error') ? detectors : providers;
  const votes = voting.map((pr) => engineStatuses[pr]);
  const succeeded = votes.filter((st) => st !== 'error');
  const changesFound = succeeded.includes('completed');

  // Whether any engine failed is a separate question from the verdict, and it
  // is the one the status used to swallow: Firecrawl finding changes while
  // Brave errored was recorded as a clean `completed`.
  const anyEngineFailed = providers.some((pr) => engineStatuses[pr] === 'error');

  let status;
  if (succeeded.length === 0) status = 'error';
  else if (anyEngineFailed) status = 'partial';
  else if (changesFound) status = 'completed';
  else if (succeeded.includes('no_history')) status = 'no_history';
  else status = 'no_changes';

  // A supplementary engine failing never changes the verdict, but it is still
  // recorded so it is visible outside the report prose.
  const errorMessage = engineErrors.length ? engineErrors.join(' · ') : null;

  // Every engine failed before saving a snapshot, so there is no snapshot to
  // reference and no row to write (new_snapshot_id is NOT NULL). Usage is not
  // charged either — nothing usable was produced.
  if (primaryNewSnapshotId === null) {
    return {
      scanId: null,
      websiteId: website.id,
      url: website.url,
      status: 'error',
      changesFound: false,
      error: lastError ? lastError.message : 'Scan failed',
      // Same key the stored row uses, so a live result and a fetched one render
      // identically in the UI.
      error_message: errorMessage,
      engine_statuses: engineStatuses,
    };
  }

  const diffSummary = diffParts.length ? diffParts.join(' · ') : null;

  const scanId = commitScan({
    website_id: website.id,
    owner_id: ownerId,
    period_days: periodDays,
    old_snapshot_id: primaryOldSnapshotId,
    new_snapshot_id: primaryNewSnapshotId,
    diff_summary: diffSummary,
    llm_summary: combined,
    status,
    error_message: errorMessage,
    triggered_by: triggeredBy,
    engines_used: providers.join('+'),
    engine_statuses: JSON.stringify(engineStatuses),
    llm_input_tokens: ledger.inputTokens,
    llm_output_tokens: ledger.outputTokens,
    duration_ms: Date.now() - startedAt,
  });

  return {
    scanId,
    websiteId: website.id,
    url: website.url,
    status,
    changesFound,
    llm_summary: combined,
    diff_summary: diffSummary,
    error: errorMessage,
    error_message: errorMessage,
    engine_statuses: engineStatuses,
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

      const scanId = commitScan({
        ...baseFields,
        new_snapshot_id: newSnapshot.id,
        status: 'no_history',
        llm_summary: markdown,
        llm_input_tokens: ledger.inputTokens,
        llm_output_tokens: ledger.outputTokens,
        duration_ms: Date.now() - startedAt,
      });

      return {
        scanId,
        websiteId: website.id,
        url: website.url,
        status: 'no_history',
        changesFound: false,
        llm_summary: markdown,
        source,
      };
    }

    const oldText = snapshotText(oldSnapshot);
    const { diffText, hasChanges, addedLines, removedLines, truncated, omittedLines } = computeDiff(
      oldText,
      contentText
    );

    if (!hasChanges) {
      const summary = `No changes detected in the PDF at ${website.url} since the last scan.`;
      const scanId = commitScan({
        ...baseFields,
        old_snapshot_id: oldSnapshot.id,
        new_snapshot_id: newSnapshot.id,
        status: 'no_changes',
        llm_summary: summary,
        duration_ms: Date.now() - startedAt,
      });

      return {
        scanId,
        websiteId: website.id,
        url: website.url,
        status: 'no_changes',
        changesFound: false,
        source,
      };
    }

    const { markdown, usage } = await summarizeChanges({
      websiteUrl: website.url,
      websiteName: website.name,
      periodDays,
      oldContent: oldText,
      newContent: contentText,
      diffText,
      pages,
      isFirstScan: false,
      diffTruncated: truncated,
      omittedLines,
    });
    recordLlm(ledger, usage);

    const diffSummary = `+${addedLines} lines / -${removedLines} lines`;

    const scanId = commitScan({
      ...baseFields,
      old_snapshot_id: oldSnapshot.id,
      new_snapshot_id: newSnapshot.id,
      diff_summary: diffSummary,
      llm_summary: markdown,
      status: 'completed',
      llm_input_tokens: ledger.inputTokens,
      llm_output_tokens: ledger.outputTokens,
      duration_ms: Date.now() - startedAt,
    });

    return {
      scanId,
      websiteId: website.id,
      url: website.url,
      status: 'completed',
      changesFound: true,
      llm_summary: markdown,
      diff_summary: diffSummary,
      source,
    };
  } catch (err) {
    console.error(`Scan failed for ${website.url}:`, err.message);

    let scanId = null;
    if (newSnapshot) {
      scanId = commitScan({
        ...baseFields,
        new_snapshot_id: newSnapshot.id,
        status: 'error',
        error_message: err.message,
        duration_ms: Date.now() - startedAt,
      });
    }

    return {
      scanId,
      websiteId: website.id,
      url: website.url,
      status: 'error',
      changesFound: false,
      error: err.message,
    };
  }
}

module.exports = {
  runSingleScan,
  resolveProviders,
  PROVIDER_ROLES,
};
