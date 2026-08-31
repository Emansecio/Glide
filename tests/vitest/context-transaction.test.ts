import { describe, expect, it } from 'vitest';
import { ContextTransactionStore } from '../../background/context-transaction.js';
import { shouldAppendAssistantFinalForCommit } from '../../sidepanel/ui/panel-guards.js';

const message = (content: string) => ({ role: 'assistant' as const, content });
const input = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'session-1',
  sourceRevision: 0,
  runId: 'run-1',
  turnId: 'turn-1',
  messages: [message('done')],
  compacted: false,
  contextUsage: { approxTokens: 2, contextLimit: 100 },
  ...overrides,
});

describe('ContextTransactionStore', () => {
  it('increments revisions monotonically', () => {
    const store = new ContextTransactionStore();
    expect(store.commit(input()).revision).toBe(1);
    expect(store.commit(input({ sourceRevision: 1, runId: 'run-2', turnId: 'turn-2' })).revision).toBe(2);
  });

  it('rejects stale source revisions', () => {
    const store = new ContextTransactionStore();
    store.commit(input());
    expect(() => store.commit(input({ sourceRevision: 0, runId: 'run-2', turnId: 'turn-2' }))).toThrow(
      /stale source revision/i,
    );
  });

  it('allows only one terminal commit per run and turn', () => {
    const store = new ContextTransactionStore();
    store.commit(input());
    expect(() =>
      store.commit(input({ sourceRevision: 1, messages: [message('different terminal payload')] })),
    ).toThrow(/already committed/i);
  });

  it('returns the prior commit for an exact duplicate', () => {
    const store = new ContextTransactionStore();
    const first = store.commit(input());
    const duplicate = store.commit(input());
    expect(duplicate).toEqual(first);
    expect(store.read('session-1').revision).toBe(1);
  });

  it('inherits revision from previous session lineage', () => {
    const store = new ContextTransactionStore();
    store.commit(input());
    const compacted = store.commit(
      input({
        sessionId: 'session-2',
        previousSessionId: 'session-1',
        sourceRevision: 1,
        runId: 'run-2',
        turnId: 'turn-2',
        compacted: true,
      }),
    );
    expect(compacted.revision).toBe(2);
  });
});

describe('panel context ordering', () => {
  it('does not append final response when matching commit arrived first', () => {
    expect(shouldAppendAssistantFinalForCommit({ contextRevision: 3, finalRevision: 3 })).toBe(false);
  });

  it('temporarily appends final when commit has not arrived yet', () => {
    expect(shouldAppendAssistantFinalForCommit({ contextRevision: 2, finalRevision: 3 })).toBe(true);
  });
});
