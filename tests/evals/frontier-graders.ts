import type { ActionAttemptState, FrontierCase, FrontierTerminalReason } from './frontier-cases.js';

export type FrontierGrade = {
  caseId: string;
  passed: boolean;
  failures: string[];
  metrics: Record<string, number>;
};

export type FrontierEvidenceSource = 'production_runtime' | 'fixture_state' | 'runtime_message' | 'storage_state';

export type FrontierEvalTrace = {
  events: Array<{
    source: FrontierEvidenceSource;
    id: string;
    actionId?: string;
    kind: string;
    frameId?: number;
  }>;
  mutations: Array<{
    source: 'fixture_state';
    actionId: string;
    requestedFrameId: number;
    actualFrameId: number;
    handleState: 'fresh' | 'stale' | 'none';
  }>;
  actionAttempts: Array<{
    source: 'production_runtime' | 'runtime_message' | 'storage_state';
    actionId: string;
    state: ActionAttemptState;
  }>;
  contextRevisions: Array<{
    source: 'production_runtime' | 'runtime_message' | 'storage_state';
    revision: number;
  }>;
  terminal: {
    source: 'production_runtime' | 'runtime_message' | 'storage_state';
    reason: FrontierTerminalReason;
  };
};

const trustedSources = new Set<FrontierEvidenceSource>([
  'production_runtime',
  'fixture_state',
  'runtime_message',
  'storage_state',
]);
const hasInvariant = (evalCase: FrontierCase, invariant: string) => evalCase.invariants.includes(invariant);
const sameTransition = (left: ActionAttemptState[], right: ActionAttemptState[]) =>
  left.length === right.length && left.every((state, index) => state === right[index]);

export const hasTrustedFrontierEvidence = (trace: FrontierEvalTrace): boolean =>
  trace.events.every((event) => trustedSources.has(event.source)) &&
  trace.mutations.every((mutation) => mutation.source === 'fixture_state') &&
  trace.actionAttempts.every(
    (attempt) =>
      attempt.source === 'production_runtime' ||
      attempt.source === 'runtime_message' ||
      attempt.source === 'storage_state',
  ) &&
  trace.contextRevisions.every(
    (commit) =>
      commit.source === 'production_runtime' ||
      commit.source === 'runtime_message' ||
      commit.source === 'storage_state',
  ) &&
  (trace.terminal.source === 'production_runtime' ||
    trace.terminal.source === 'runtime_message' ||
    trace.terminal.source === 'storage_state');

export const gradeFrontierCase = (evalCase: FrontierCase, trace: FrontierEvalTrace): FrontierGrade => {
  const failures: string[] = [];

  if (!hasTrustedFrontierEvidence(trace)) failures.push('untrusted trace source');

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

  const revisions = trace.contextRevisions.map((commit) => commit.revision);
  if (
    hasInvariant(evalCase, 'context_revision') &&
    (revisions.length === 0 ||
      revisions.some(
        (revision, index) =>
          !Number.isInteger(revision) || revision < 0 || (index > 0 && revision <= revisions[index - 1]),
      ))
  ) {
    failures.push('missing context revision');
  }

  if (hasInvariant(evalCase, 'terminal_reason') && trace.terminal.reason !== evalCase.expectedTerminalReason) {
    failures.push(`terminal reason ${trace.terminal.reason}; expected ${evalCase.expectedTerminalReason}`);
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
