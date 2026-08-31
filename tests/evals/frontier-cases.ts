export type ActionAttemptState = 'prepared' | 'in_flight' | 'committed' | 'ambiguous';

export type FrontierEffectExpectation = {
  events: number;
  mutations: number;
  committedAttempts: number;
  allowedActionTransitions: ActionAttemptState[][];
};

export type FrontierCase = {
  id: string;
  fixture: string;
  goal: string;
  invariants: string[];
  timeoutMs: number;
  expectedEffects?: FrontierEffectExpectation;
};

const actionInvariants = ['single_event', 'frame_safe', 'fresh_handle', 'no_ambiguous_replay', 'context_revision'];
const acceptedSingleEffect: FrontierEffectExpectation = {
  events: 1,
  mutations: 1,
  committedAttempts: 1,
  allowedActionTransitions: [['committed'], ['prepared', 'in_flight', 'committed']],
};
const rejectedEffect: FrontierEffectExpectation = {
  events: 1,
  mutations: 0,
  committedAttempts: 0,
  allowedActionTransitions: [['prepared'], ['ambiguous']],
};

export const frontierCases: FrontierCase[] = [
  {
    id: 'click-once',
    fixture: 'tests/e2e/fixtures/action-lab.html#click-once',
    goal: 'One accepted click produces one event and one mutation.',
    invariants: [...actionInvariants, 'terminal_reason'],
    timeoutMs: 10_000,
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'form-frame',
    fixture: 'tests/e2e/fixtures/frame-lab.html#checkbox-frame',
    goal: 'One form mutation remains inside requested frame.',
    invariants: [...actionInvariants, 'terminal_reason'],
    timeoutMs: 10_000,
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'stale-handle',
    fixture: 'tests/e2e/test-stable-handles.ts#stale-handle',
    goal: 'Stale target fails closed without mutation.',
    invariants: ['fresh_handle', 'no_ambiguous_replay', 'context_revision', 'terminal_reason'],
    timeoutMs: 10_000,
    expectedEffects: rejectedEffect,
  },
  {
    id: 'shadow-dialog',
    fixture: 'tests/vitest/stable-element-handle.test.ts#shadow-dialog',
    goal: 'Shadow target resolves once with its stable handle.',
    invariants: [...actionInvariants, 'terminal_reason'],
    timeoutMs: 10_000,
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'spa-navigation',
    fixture: 'tests/vitest/action-postcondition.test.ts#spa-navigation',
    goal: 'SPA state transition yields newer evidence revision.',
    invariants: ['single_event', 'context_revision', 'terminal_reason'],
    timeoutMs: 10_000,
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'compaction-stop',
    fixture: 'tests/vitest/compaction-transaction.test.ts#compaction-stop',
    goal: 'Stop prevents stale compaction commit.',
    invariants: ['context_revision', 'terminal_reason'],
    timeoutMs: 10_000,
    expectedEffects: { events: 1, mutations: 0, committedAttempts: 0, allowedActionTransitions: [] },
  },
  {
    id: 'worker-safe-resume',
    fixture: 'tests/e2e/test-worker-recovery.ts#safe-resume',
    goal: 'Safe checkpoint resumes without replay.',
    invariants: ['no_ambiguous_replay', 'context_revision', 'terminal_reason'],
    timeoutMs: 15_000,
    expectedEffects: { events: 1, mutations: 0, committedAttempts: 0, allowedActionTransitions: [] },
  },
  {
    id: 'worker-ambiguous-action',
    fixture: 'tests/e2e/test-worker-recovery.ts#ambiguous-action',
    goal: 'Ambiguous action pauses without replay.',
    invariants: ['no_ambiguous_replay', 'context_revision', 'terminal_reason'],
    timeoutMs: 15_000,
    expectedEffects: rejectedEffect,
  },
  {
    id: 'long-markdown',
    fixture: 'tests/vitest/markdown-renderer.test.ts#long-markdown',
    goal: 'Long Markdown finishes with one context commit.',
    invariants: ['context_revision', 'terminal_reason'],
    timeoutMs: 10_000,
  },
  {
    id: 'history-restart',
    fixture: 'tests/vitest/history-budget.test.ts#history-restart',
    goal: 'Restart restores history and monotonically advances context.',
    invariants: ['context_revision', 'terminal_reason'],
    timeoutMs: 10_000,
  },
];
