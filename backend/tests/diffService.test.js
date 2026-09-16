/**
 * Diff truncation.
 *
 * The diff used to be cut at 8,000 characters and then cut again to 6,000 in
 * the prompt, with nothing saying so. The model was handed a partial account of
 * what changed and asked to describe what changed.
 */

const { computeDiff, MAX_DIFF_CHARS } = require('../src/services/diffService');

describe('computeDiff', () => {
  it('reports no changes for identical content', () => {
    const result = computeDiff('same\ncontent', 'same\ncontent');

    expect(result.hasChanges).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.diffText).toBe('');
  });

  it('counts added and removed lines', () => {
    const result = computeDiff('one\ntwo\nthree\n', 'one\ntwo\nthree\nfour\n');

    expect(result.hasChanges).toBe(true);
    expect(result.addedLines).toBe(1);
    expect(result.diffText).toContain('+ four');
  });

  it('leaves a small diff untruncated', () => {
    const result = computeDiff('a\n', 'a\nb\n');

    expect(result.truncated).toBe(false);
    expect(result.omittedLines).toBe(0);
    expect(result.diffText).not.toContain('diff truncated');
  });

  it('says how much it dropped when the diff is too large', () => {
    const before = '';
    const after = Array.from(
      { length: 20000 },
      (_, i) => `line ${i} of a very long document`
    ).join('\n');

    const result = computeDiff(before, after);

    expect(result.truncated).toBe(true);
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(result.diffText).toMatch(/diff truncated: \d+ of \d+ changed lines shown/);
    expect(result.diffText.length).toBeLessThan(MAX_DIFF_CHARS + 200);
    // The full diff is still available to callers that can use it.
    expect(result.fullDiffText.length).toBeGreaterThan(result.diffText.length);
  });

  it('truncates on a line boundary rather than mid-line', () => {
    const after = Array.from(
      { length: 20000 },
      (_, i) => `line ${i} of a very long document`
    ).join('\n');
    const { diffText, truncated } = computeDiff('', after);

    expect(truncated).toBe(true);
    const body = diffText.split('\n').filter((l) => l.startsWith('+ '));
    expect(body.every((l) => /^\+ line \d+ of a very long document$/.test(l))).toBe(true);
  });
});
