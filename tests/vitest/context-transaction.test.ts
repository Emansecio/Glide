import { describe, expect, it } from 'vitest';
import { ContextTransactionStore } from '../../background/context-transaction.js';
import { isContextLineageAcknowledged, shouldAppendAssistantFinalForCommit } from '../../sidepanel/ui/panel-guards.js';

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
    expect(() => store.commit(input({ sourceRevision: 1, messages: [message('different terminal payload')] }))).toThrow(
      /already committed/i,
    );
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

  it('adopts an explicit warm-panel revision into a cold worker lineage', () => {
    const restarted = new ContextTransactionStore();
    const history = [
      { role: 'user' as const, content: 'first' },
      message('first final'),
      { role: 'user' as const, content: 'continue after restart' },
    ];

    const adoption = restarted.adoptLineage('session-1', 4, history);
    expect(adoption).toEqual({ accepted: true, state: 'cold_adopted', revision: 4 });

    const commit = restarted.commit(
      input({
        sourceRevision: 4,
        runId: 'run-after-restart',
        turnId: 'turn-after-restart',
        messages: [...history, message('second final')],
      }),
    );
    expect(commit.revision).toBe(5);
    expect(commit.messages.filter((entry) => String(entry.content).includes('second final'))).toHaveLength(1);
  });

  it('rejects a mismatched panel revision when worker lineage is already warm', () => {
    const store = new ContextTransactionStore();
    store.hydrate('session-1', 3, [message('canonical')]);
    expect(store.adoptLineage('session-1', 2, [message('stale')])).toEqual({
      accepted: false,
      state: 'revision_mismatch',
      revision: 3,
    });
    expect(store.read('session-1').messages[0].content).toBe('canonical');
  });

  it('bounds session snapshots and terminal commit retention with LRU eviction', () => {
    const store = new ContextTransactionStore({
      maxSessions: 2,
      maxTerminalDigests: 3,
      maxTerminalPayloads: 1,
    });
    for (let index = 1; index <= 4; index += 1) {
      store.commit(
        input({
          sessionId: `session-${index}`,
          runId: `run-${index}`,
          turnId: `turn-${index}`,
          messages: [message(`payload-${index}`)],
        }),
      );
    }

    expect(store.retentionCardinality()).toEqual({ sessions: 2, terminalDigests: 3, terminalPayloads: 1 });
    expect(store.read('session-1')).toEqual({ revision: 0, messages: [] });
    expect(store.read('session-4').revision).toBe(1);
  });

  it('keeps exact terminal commit idempotency after releasing full payload', () => {
    const store = new ContextTransactionStore({ maxTerminalPayloads: 1 });
    const commitInput = input({ messages: [message('large terminal payload '.repeat(1_000))] });
    const first = store.commit(commitInput);

    store.releaseTerminalCommitPayload(first.runId, first.turnId);

    expect(store.retentionCardinality().terminalPayloads).toBe(0);
    expect(store.commit(commitInput)).toEqual(first);
    expect(() => store.commit({ ...commitInput, messages: [message('changed')] })).toThrow(/already committed/i);
  });
});

describe('panel context ordering', () => {
  it('does not append final response when matching commit arrived first', () => {
    expect(shouldAppendAssistantFinalForCommit({ contextRevision: 3, finalRevision: 3 })).toBe(false);
  });

  it('temporarily appends final when commit has not arrived yet', () => {
    expect(shouldAppendAssistantFinalForCommit({ contextRevision: 2, finalRevision: 3 })).toBe(true);
  });

  it('accepts only a matching explicit cold-lineage acknowledgement', () => {
    expect(
      isContextLineageAcknowledged({
        contextRevision: 4,
        contextLineage: { state: 'cold_adopted', revision: 4 },
      }),
    ).toBe(true);
    expect(
      isContextLineageAcknowledged({
        contextRevision: 4,
        contextLineage: { state: 'cold_adopted', revision: 0 },
      }),
    ).toBe(false);
  });
});
