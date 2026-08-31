import { describe, expect, it } from 'vitest';
import type { FrontierCase } from '../evals/frontier-cases.js';
import { type FrontierEvalTrace, gradeFrontierCase } from '../evals/frontier-graders.js';

const evalCase: FrontierCase = {
  id: 'test-case',
  fixture: 'local:test',
  goal: 'exercise invariant grader',
  invariants: [
    'single_event',
    'frame_safe',
    'fresh_handle',
    'no_ambiguous_replay',
    'context_revision',
    'terminal_reason',
  ],
  timeoutMs: 1_000,
};

const trace = (overrides: Partial<FrontierEvalTrace> = {}): FrontierEvalTrace => ({
  events: [{ id: 'event-1', actionId: 'action-1', kind: 'mutation', frameId: 2 }],
  mutations: [{ actionId: 'action-1', requestedFrameId: 2, actualFrameId: 2, handleState: 'fresh' }],
  actionAttempts: [{ actionId: 'action-1', state: 'committed' }],
  contextRevisions: [4],
  terminalReason: 'completed',
  expectedTerminalReason: 'completed',
  ...overrides,
});

describe('frontier invariant grader', () => {
  it('passes a trace satisfying every declared invariant', () => {
    expect(gradeFrontierCase(evalCase, trace())).toEqual({
      caseId: 'test-case',
      passed: true,
      failures: [],
      metrics: {
        actionAttempts: 1,
        contextCommits: 1,
        events: 1,
        mutations: 1,
      },
    });
  });

  it.each([
    [
      'duplicate events',
      trace({
        events: [
          { id: 'same', kind: 'mutation' },
          { id: 'same', kind: 'mutation' },
        ],
      }),
      'duplicate event',
    ],
    [
      'cross-frame mutation',
      trace({ mutations: [{ actionId: 'action-1', requestedFrameId: 2, actualFrameId: 7, handleState: 'fresh' }] }),
      'cross-frame mutation',
    ],
    [
      'stale-handle mutation',
      trace({ mutations: [{ actionId: 'action-1', requestedFrameId: 2, actualFrameId: 2, handleState: 'stale' }] }),
      'stale handle mutated',
    ],
    [
      'repeated ambiguous action',
      trace({
        actionAttempts: [
          { actionId: 'ambiguous-1', state: 'ambiguous' },
          { actionId: 'ambiguous-1', state: 'committed' },
        ],
      }),
      'ambiguous action replayed',
    ],
    ['missing context revision', trace({ contextRevisions: [] }), 'missing context revision'],
    [
      'wrong terminal reason',
      trace({ terminalReason: 'failed', expectedTerminalReason: 'completed' }),
      'terminal reason failed; expected completed',
    ],
  ])('fails on %s', (_name, input, expectedFailure) => {
    const grade = gradeFrontierCase(evalCase, input);
    expect(grade.passed).toBe(false);
    expect(grade.failures).toContain(expectedFailure);
  });
});
