export type ActionAttemptState = 'prepared' | 'in_flight' | 'committed' | 'ambiguous';
export type FrontierTerminalReason =
  | 'completed'
  | 'awaiting_user'
  | 'stopped'
  | 'failed'
  | 'interrupted'
  | 'ambiguous_action';

type FrontierEffectExpectation = {
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
  expectedTerminalReason: FrontierTerminalReason;
  expectedEffects?: FrontierEffectExpectation;
};

const actionInvariants = ['single_event', 'frame_safe', 'fresh_handle', 'no_ambiguous_replay', 'context_revision'];
const acceptedSingleEffect: FrontierEffectExpectation = {
  events: 1,
  mutations: 1,
  committedAttempts: 1,
  allowedActionTransitions: [['committed']],
};
const rejectedKnownEffect: FrontierEffectExpectation = {
  events: 1,
  mutations: 0,
  committedAttempts: 1,
  allowedActionTransitions: [['committed']],
};

export const frontierCases: FrontierCase[] = [
  {
    id: 'click-once',
    fixture: 'tests/e2e/fixtures/action-lab.html#click-once',
    goal: 'One accepted click produces one event and one mutation.',
    invariants: [...actionInvariants, 'terminal_reason'],
    timeoutMs: 20_000,
    expectedTerminalReason: 'completed',
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'form-frame',
    fixture: 'tests/e2e/fixtures/frame-lab.html#checkbox-frame',
    goal: 'One form mutation remains inside requested frame.',
    invariants: [...actionInvariants, 'terminal_reason'],
    timeoutMs: 20_000,
    expectedTerminalReason: 'completed',
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'stale-handle',
    fixture: 'tests/e2e/test-stable-handles.ts#stale-handle',
    goal: 'Stale target fails closed without mutation.',
    invariants: ['fresh_handle', 'no_ambiguous_replay', 'context_revision', 'terminal_reason'],
    timeoutMs: 20_000,
    expectedTerminalReason: 'failed',
    expectedEffects: rejectedKnownEffect,
  },
  {
    id: 'shadow-dialog',
    fixture: 'tests/e2e/fixtures/action-lab.html#shadow-dialog',
    goal: 'Shadow target resolves once and opens one dialog.',
    invariants: [...actionInvariants, 'terminal_reason'],
    timeoutMs: 20_000,
    expectedTerminalReason: 'completed',
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'spa-navigation',
    fixture: 'tests/e2e/fixtures/action-lab.html#spa-navigation',
    goal: 'SPA state transition yields newer observed navigation state.',
    invariants: [...actionInvariants, 'terminal_reason'],
    timeoutMs: 20_000,
    expectedTerminalReason: 'completed',
    expectedEffects: acceptedSingleEffect,
  },
  {
    id: 'compaction-stop',
    fixture: 'tests/e2e/test-frontier-runtime-evals.ts#compaction-stop',
    goal: 'Stop prevents a late production context commit.',
    invariants: ['context_revision', 'terminal_reason'],
    timeoutMs: 30_000,
    expectedTerminalReason: 'stopped',
  },
  {
    id: 'worker-safe-resume',
    fixture: 'tests/e2e/test-worker-recovery.ts#safe-resume',
    goal: 'Safe checkpoint resumes without replay.',
    invariants: ['no_ambiguous_replay', 'context_revision', 'terminal_reason'],
    timeoutMs: 45_000,
    expectedTerminalReason: 'completed',
  },
  {
    id: 'worker-ambiguous-action',
    fixture: 'tests/e2e/test-worker-recovery.ts#ambiguous-action',
    goal: 'Ambiguous action pauses without replay.',
    invariants: ['no_ambiguous_replay', 'context_revision', 'terminal_reason'],
    timeoutMs: 45_000,
    expectedTerminalReason: 'ambiguous_action',
    expectedEffects: {
      events: 1,
      mutations: 0,
      committedAttempts: 0,
      allowedActionTransitions: [['ambiguous']],
    },
  },
  {
    id: 'long-markdown',
    fixture: 'tests/e2e/test-frontier-runtime-evals.ts#long-markdown',
    goal: 'Long Markdown finishes through production render and context commit.',
    invariants: ['context_revision', 'terminal_reason'],
    timeoutMs: 30_000,
    expectedTerminalReason: 'completed',
  },
  {
    id: 'history-restart',
    fixture: 'tests/e2e/test-frontier-runtime-evals.ts#history-restart',
    goal: 'Production history reload preserves report and revision evidence.',
    invariants: ['context_revision', 'terminal_reason'],
    timeoutMs: 30_000,
    expectedTerminalReason: 'completed',
  },
];
