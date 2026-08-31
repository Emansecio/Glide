import { describe, expect, it } from 'vitest';
import { buildPackedToolDefinitions, selectToolPacks } from '../../ai/tool-packs.js';

describe('adaptive browser tool packs', () => {
  it('keeps simple click schema under 12,000 JSON characters', () => {
    const packs = selectToolPacks({ text: 'click Save on this page' });
    const tools = buildPackedToolDefinitions(packs, Number.POSITIVE_INFINITY);
    expect(packs).toEqual(['core']);
    expect(JSON.stringify(tools).length).toBeLessThan(12_000);
    expect(tools.map((tool) => tool.name)).toContain('click');
  });

  it('adds forms and extract packs from intent', () => {
    expect(selectToolPacks({ text: 'fill and submit this registration form' })).toContain('forms');
    expect(selectToolPacks({ text: 'analyze and extract this table' })).toContain('extract');
  });

  it('adds diagnostics after failure', () => {
    expect(selectToolPacks({ text: 'click Save', activeFailure: true })).toContain('diagnostics');
  });

  it('retains definitions needed by outstanding calls', () => {
    const packs = selectToolPacks({ text: 'continue', outstandingToolNames: ['extractTable', 'cdp'] });
    const names = buildPackedToolDefinitions(packs, 10).map((tool) => tool.name);
    expect(names).toContain('extractTable');
    expect(names).toContain('cdp');
  });
});
