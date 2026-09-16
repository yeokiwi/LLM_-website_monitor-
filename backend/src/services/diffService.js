const { diffLines } = require('diff');

/**
 * Character budget for the diff body handed to the LLM.
 *
 * Raised from 8,000: the prompt used to re-truncate this to 6,000 silently, so
 * anything past that point was neither shown to the model nor acknowledged.
 *
 * This is deliberately far larger than one prompt's diff budget. llmService
 * condenses anything over that budget chunk by chunk, so the limit here is the
 * point past which even chunking would cost more than it is worth — and when it
 * is reached the cut is explicit (see `truncated`/`omittedLines`) and stated in
 * the prompt rather than passed off as the whole story.
 */
const MAX_DIFF_CHARS = 120000;

/**
 * Compute a human-readable diff between two content strings.
 * Returns a summary string suitable for sending to the LLM.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ diffText: string, fullDiffText: string, addedLines: number,
 *             removedLines: number, hasChanges: boolean, truncated: boolean,
 *             omittedLines: number }}
 */
function computeDiff(oldText, newText) {
  if (oldText === newText) {
    return {
      diffText: '',
      fullDiffText: '',
      addedLines: 0,
      removedLines: 0,
      hasChanges: false,
      truncated: false,
      omittedLines: 0,
    };
  }

  const parts = diffLines(oldText, newText, { ignoreWhitespace: true });

  let addedLines = 0;
  let removedLines = 0;
  const diffLines_ = [];

  for (const part of parts) {
    const lineCount = (part.value.match(/\n/g) || []).length || 1;
    if (part.added) {
      addedLines += lineCount;
      part.value
        .split('\n')
        .filter(Boolean)
        .forEach((line) => diffLines_.push(`+ ${line}`));
    } else if (part.removed) {
      removedLines += lineCount;
      part.value
        .split('\n')
        .filter(Boolean)
        .forEach((line) => diffLines_.push(`- ${line}`));
    }
    // unchanged lines are omitted to keep the diff concise
  }

  const header = [
    `=== DIFF SUMMARY ===`,
    `Lines added:   ${addedLines}`,
    `Lines removed: ${removedLines}`,
    ``,
    `=== CHANGES ===`,
  ].join('\n');

  const fullDiffText = `${header}\n${diffLines_.join('\n')}`;

  // Keep whole lines, and say out loud what was dropped. A diff that silently
  // stops mid-way reads to the model (and to the reader of the report) as a
  // complete account of what changed.
  let diffText = fullDiffText;
  let truncated = false;
  let omittedLines = 0;

  if (fullDiffText.length > MAX_DIFF_CHARS) {
    const kept = [];
    let used = header.length + 1;
    for (const line of diffLines_) {
      if (used + line.length + 1 > MAX_DIFF_CHARS) break;
      used += line.length + 1;
      kept.push(line);
    }

    truncated = true;
    omittedLines = diffLines_.length - kept.length;
    diffText = [
      header,
      kept.join('\n'),
      '',
      `… diff truncated: ${kept.length} of ${diffLines_.length} changed lines shown ` +
        `(${fullDiffText.length - used} characters omitted).`,
    ].join('\n');
  }

  return {
    diffText,
    fullDiffText,
    addedLines,
    removedLines,
    hasChanges: addedLines > 0 || removedLines > 0,
    truncated,
    omittedLines,
  };
}

module.exports = { computeDiff, MAX_DIFF_CHARS };
