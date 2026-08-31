import { describe, expect, it } from 'vitest';
import { resolveRunTerminalReason } from '../../background/run-terminal-reason.js';
import { textAwaitsUser } from '../../background/continuation-intent.js';

const reasonForText = (text: string) =>
  resolveRunTerminalReason({ awaitsUser: textAwaitsUser(text), stopped: false, ambiguous: false, failed: false });

describe('run terminal reasons', () => {
  it('maps user handoff text to awaiting_user', () => {
    expect(reasonForText('Faça login e me avise quando estiver pronto.')).toBe('awaiting_user');
  });

  it('maps stop, ambiguous action, and failure explicitly', () => {
    expect(resolveRunTerminalReason({ stopped: true })).toBe('stopped');
    expect(resolveRunTerminalReason({ ambiguous: true })).toBe('ambiguous_action');
    expect(resolveRunTerminalReason({ failed: true })).toBe('failed');
  });

  it('maps valid normal final to completed', () => {
    expect(reasonForText('Tarefa concluída com sucesso.')).toBe('completed');
  });
});
