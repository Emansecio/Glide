import type { FrontierCase } from './frontier-cases.js';

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
  actionAttempts: Array<{ actionId: string; state: 'prepared' | 'in_flight' | 'committed' | 'ambiguous' }>;
  contextRevisions: number[];
  terminalReason: string;
  expectedTerminalReason: string;
};

const hasInvariant = (evalCase: FrontierCase, invariant: string) => evalCase.invariants.includes(invariant);

export const gradeFrontierCase = (evalCase: FrontierCase, trace: FrontierEvalTrace): FrontierGrade => {
  const failures: string[] = [];

  if (hasInvariant(evalCase, 'single_event')) {
    const seen = new Set<string>();
    for (const event of trace.events) {
      if (seen.has(event.id)) failures.push('duplicate event');
      seen.add(event.id);
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
    const ambiguous = new Set(
      trace.actionAttempts.filter((attempt) => attempt.state === 'ambiguous').map((attempt) => attempt.actionId),
    );
    if (trace.actionAttempts.some((attempt) => ambiguous.has(attempt.actionId) && attempt.state !== 'ambiguous')) {
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
