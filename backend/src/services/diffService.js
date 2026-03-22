const { diffLines } = require('diff');

const MAX_DIFF_CHARS = 8000;

/**
 * Compute a human-readable diff between two content strings.
 * Returns a summary string suitable for sending to the LLM.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ diffText: string, addedLines: number, removedLines: number, hasChanges: boolean }}
 */
function computeDiff(oldText, newText) {
  if (oldText === newText) {
    return { diffText: '', addedLines: 0, removedLines: 0, hasChanges: false };
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

  const diffBody = diffLines_.join('\n');
  const fullDiff = `${header}\n${diffBody}`;

  return {
    diffText: fullDiff.slice(0, MAX_DIFF_CHARS),
    addedLines,
    removedLines,
    hasChanges: addedLines > 0 || removedLines > 0,
  };
}

module.exports = { computeDiff };
