import type { ActionAttemptState, FrontierCase } from './frontier-cases.js';

export type FrontierGrade = {
  caseId: string;
  passed: boolean;
  failures: string[];
  metrics: Record<string, number>;
};

export type FrontierEvalTrace = {
  events: Array<{ id: string; actionId?: string; kind: string; frameId?: number }>;
  mutations: Array<{
    actionId: string;
    requestedFrameId: number;
    actualFrameId: number;
    handleState: 'fresh' | 'stale' | 'none';
  }>;
  actionAttempts: Array<{ actionId: string; state: ActionAttemptState }>;
  contextRevisions: number[];
  terminalReason: string;
  expectedTerminalReason: string;
};

const hasInvariant = (evalCase: FrontierCase, invariant: string) => evalCase.invariants.includes(invariant);
const sameTransition = (left: ActionAttemptState[], right: ActionAttemptState[]) =>
  left.length === right.length && left.every((state, index) => state === right[index]);

export const gradeFrontierCase = (evalCase: FrontierCase, trace: FrontierEvalTrace): FrontierGrade => {
  const failures: string[] = [];

  if (hasInvariant(evalCase, 'single_event')) {
    const seen = new Set<string>();
    for (const event of trace.events) {
      if (seen.has(event.id)) failures.push('duplicate event');
      seen.add(event.id);
    }
  }

  if (evalCase.expectedEffects) {
    const expected = evalCase.expectedEffects;
    const committedAttempts = trace.actionAttempts.filter((attempt) => attempt.state === 'committed').length;
    if (trace.events.length !== expected.events) {
      failures.push(`event count ${trace.events.length}; expected ${expected.events}`);
    }
    if (trace.mutations.length !== expected.mutations) {
      failures.push(`mutation count ${trace.mutations.length}; expected ${expected.mutations}`);
    }
    if (committedAttempts !== expected.committedAttempts) {
      failures.push(`committed attempt count ${committedAttempts}; expected ${expected.committedAttempts}`);
    }

    const transitions = new Map<string, ActionAttemptState[]>();
    for (const attempt of trace.actionAttempts) {
      const states = transitions.get(attempt.actionId) || [];
      states.push(attempt.state);
      transitions.set(attempt.actionId, states);
    }
    for (const [actionId, states] of transitions) {
      if (!expected.allowedActionTransitions.some((allowed) => sameTransition(states, allowed))) {
        failures.push(`invalid action transition ${actionId}: ${states.join(' -> ')}`);
      }
    }
  }

  if (
    hasInvariant(evalCase, 'frame_safe') &&
    trace.mutations.some((mutation) => mutation.requestedFrameId !== mutation.actualFrameId)
  ) {
    failures.push('cross-frame mutation');
  }

  if (hasInvariant(evalCase, 'fresh_handle') && trace.mutations.some((mutation) => mutation.handleState === 'stale')) {
    failures.push('stale handle mutated');
  }

  if (hasInvariant(evalCase, 'no_ambiguous_replay')) {
    const attemptsByAction = new Map<string, ActionAttemptState[]>();
    for (const attempt of trace.actionAttempts) {
      const states = attemptsByAction.get(attempt.actionId) || [];
      states.push(attempt.state);
      attemptsByAction.set(attempt.actionId, states);
    }
    if (
      [...attemptsByAction.values()].some((states) => {
        const ambiguousIndex = states.indexOf('ambiguous');
        return ambiguousIndex >= 0 && ambiguousIndex < states.length - 1;
      })
    ) {
      failures.push('ambiguous action replayed');
    }
  }

  if (
    hasInvariant(evalCase, 'context_revision') &&
    (trace.contextRevisions.length === 0 ||
      trace.contextRevisions.some(
        (revision, index) =>
          !Number.isInteger(revision) || revision < 0 || (index > 0 && revision <= trace.contextRevisions[index - 1]),
      ))
  ) {
    failures.push('missing context revision');
  }

  if (hasInvariant(evalCase, 'terminal_reason') && trace.terminalReason !== trace.expectedTerminalReason) {
    failures.push(`terminal reason ${trace.terminalReason}; expected ${trace.expectedTerminalReason}`);
  }

  return {
    caseId: evalCase.id,
    passed: failures.length === 0,
    failures,
    metrics: {
      actionAttempts: trace.actionAttempts.length,
      contextCommits: trace.contextRevisions.length,
      events: trace.events.length,
      mutations: trace.mutations.length,
    },
  };
};
