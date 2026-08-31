import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '../../ai/default-prompt.js';
import { resolveSystemPromptMode, withScopedOwnership } from '../../ai/system-prompt-mode.js';

describe('system prompt identity', () => {
  it('keeps custom prompts containing Glide browser automation as custom', () => {
    expect(resolveSystemPromptMode('My custom Glide browser automation policy', undefined)).toBe('custom');
  });

  it('migrates only exact normalized shipped default to default mode', () => {
    expect(resolveSystemPromptMode(`\n${DEFAULT_SYSTEM_PROMPT.replace(/\n/g, '\r\n')}\n`, undefined)).toBe('default');
  });

  it('honors an already persisted explicit mode', () => {
    expect(resolveSystemPromptMode(DEFAULT_SYSTEM_PROMPT, 'custom')).toBe('custom');
  });
});

describe('manual tool ownership lease', () => {
  it('returns underlying result and restores previous owner', async () => {
    const state = { owner: 'previous' as string | null };
    const result = await withScopedOwnership(
      'manual-run',
      () => state.owner,
      (owner) => {
        state.owner = owner;
      },
      async () => ({ success: true, value: 42 }),
    );
    expect(result).toEqual({ success: true, value: 42 });
    expect(state.owner).toBe('previous');
  });
});
