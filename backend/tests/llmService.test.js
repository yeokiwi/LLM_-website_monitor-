/**
 * Reading a Claude response.
 *
 * The reported bug: a scan completed successfully and filed a report that said
 * "No analysis generated." The response was fine — its first content block was
 * a `thinking` block, and the reader only ever looked at `content[0].text`.
 *
 * The other two cases pinned here are stop reasons that mean the report is not
 * a report. Both used to be filed as clean results with no indication that
 * anything had gone wrong.
 */

const { readClaudeReport } = require('../src/services/llmService');

describe('readClaudeReport', () => {
  it('returns the text when the response opens with a thinking block', () => {
    const markdown = readClaudeReport({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'Let me look at the diff…' },
        { type: 'text', text: '## Executive Summary\n\nThree pages changed.' },
      ],
    });

    expect(markdown).toContain('Three pages changed.');
    expect(markdown).not.toContain('No analysis generated');
  });

  it('joins every text block rather than only the first', () => {
    const markdown = readClaudeReport({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: '## Executive Summary\n\nPart one.' },
        { type: 'text', text: '\n\n## Policy & Terms Changes\n\nPart two.' },
      ],
    });

    expect(markdown).toContain('Part one.');
    expect(markdown).toContain('Part two.');
  });

  it('names a refusal instead of filing it as a report', () => {
    const markdown = readClaudeReport({
      stop_reason: 'refusal',
      stop_details: { category: 'harmful_content' },
      content: [],
    });

    expect(markdown).toMatch(/declined/i);
    expect(markdown).toContain('harmful_content');
  });

  it('flags a report cut off at the output limit', () => {
    const markdown = readClaudeReport({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '## Executive Summary\n\nThe site added a n' }],
    });

    // The partial report is kept — it is still worth reading — but it is not
    // presented as a complete one.
    expect(markdown).toContain('The site added a n');
    expect(markdown).toMatch(/truncated/i);
  });

  it('says so when the limit was reached before any text was written', () => {
    const markdown = readClaudeReport({
      stop_reason: 'max_tokens',
      content: [{ type: 'thinking', thinking: 'a very long deliberation' }],
    });

    expect(markdown).toMatch(/output limit/i);
    expect(markdown).not.toMatch(/truncated/i);
  });

  it('falls back when the response genuinely carries no text', () => {
    expect(readClaudeReport({ stop_reason: 'end_turn', content: [] })).toBe(
      '## Executive Summary\n\nNo analysis generated.'
    );
    expect(readClaudeReport({ stop_reason: 'end_turn' })).toBe(
      '## Executive Summary\n\nNo analysis generated.'
    );
  });
});
