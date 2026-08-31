import { describe, expect, it } from 'vitest';
import { collectOutstandingToolNames, resolveBrowserToolPassState } from '../../background/tool-pack-state.js';
import { buildToolDefinitions } from '../../tools/tool-definitions.js';

describe('background adaptive tool-pack state', () => {
  const definitions = buildToolDefinitions(Number.POSITIVE_INFINITY);

  it('builds each pass from real task text and surfaces deterministic pack state', () => {
    const pass = resolveBrowserToolPassState(definitions, {
      taskText: 'Fill registration form, upload resume, then submit',
      activeFailure: false,
      messages: [],
    });

    expect(pass.packs).toEqual(['core', 'forms']);
    expect(pass.definitions.map((tool) => tool.name)).toContain('fillForm');
    expect(pass.prompt).toBe('Active browser tool packs: core, forms.');
  });

  it('adds diagnostics on recovery pass and retains outstanding-call packs', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'extractTable' }],
      },
    ];
    const pass = resolveBrowserToolPassState(definitions, {
      taskText: 'Continue current browser task',
      activeFailure: true,
      messages,
    });

    expect(pass.packs).toEqual(['core', 'extract', 'diagnostics']);
    expect(pass.definitions.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['extractTable', 'getConsoleOutput']),
    );
    expect(pass.outstandingToolNames).toEqual(['extractTable']);
  });

  it('drops outstanding status after matching tool result', () => {
    expect(
      collectOutstandingToolNames([
        { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'cdp' }] },
        { role: 'tool', toolCallId: 'call-1' },
      ]),
    ).toEqual([]);
  });
});
