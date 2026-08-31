import { describe, expect, it } from 'vitest';
import type { FrontierCase } from '../evals/frontier-cases.js';
import { type FrontierEvalTrace, gradeFrontierCase } from '../evals/frontier-graders.js';
import { FRONTIER_TRACE_PREFIX, parseFrontierTraceOutput } from '../evals/frontier-trace.js';

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
  expectedEffects: {
    events: 1,
    mutations: 1,
    committedAttempts: 1,
    allowedActionTransitions: [['prepared', 'in_flight', 'committed']],
  },
};

const trace = (overrides: Partial<FrontierEvalTrace> = {}): FrontierEvalTrace => ({
  events: [{ id: 'event-1', actionId: 'action-1', kind: 'mutation', frameId: 2 }],
  mutations: [{ actionId: 'action-1', requestedFrameId: 2, actualFrameId: 2, handleState: 'fresh' }],
  actionAttempts: [
    { actionId: 'action-1', state: 'prepared' },
    { actionId: 'action-1', state: 'in_flight' },
    { actionId: 'action-1', state: 'committed' },
  ],
  contextRevisions: [4],
  terminalReason: 'completed',
  expectedTerminalReason: 'completed',
  ...overrides,
});

describe('frontier invariant grader', () => {
  it('passes exact effect counts and allowed action transition', () => {
    expect(gradeFrontierCase(evalCase, trace())).toEqual({
      caseId: 'test-case',
      passed: true,
      failures: [],
      metrics: {
        actionAttempts: 3,
        contextCommits: 1,
        events: 1,
        mutations: 1,
      },
    });
  });

  it.each([
    [
      'multiple unique events',
      trace({
        events: [
          { id: 'first', kind: 'mutation' },
          { id: 'second', kind: 'mutation' },
        ],
      }),
      'event count 2; expected 1',
    ],
    [
      'multiple mutations',
      trace({
        mutations: [
          { actionId: 'action-1', requestedFrameId: 2, actualFrameId: 2, handleState: 'fresh' },
          { actionId: 'action-2', requestedFrameId: 2, actualFrameId: 2, handleState: 'fresh' },
        ],
      }),
      'mutation count 2; expected 1',
    ],
    [
      'multiple committed attempts',
      trace({
        actionAttempts: [
          { actionId: 'action-1', state: 'prepared' },
          { actionId: 'action-1', state: 'in_flight' },
          { actionId: 'action-1', state: 'committed' },
          { actionId: 'action-2', state: 'committed' },
        ],
      }),
      'committed attempt count 2; expected 1',
    ],
    [
      'invalid transition',
      trace({
        actionAttempts: [
          { actionId: 'action-1', state: 'prepared' },
          { actionId: 'action-1', state: 'committed' },
        ],
      }),
      'invalid action transition action-1: prepared -> committed',
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
      'post-ambiguous replay',
      trace({
        actionAttempts: [
          { actionId: 'action-1', state: 'ambiguous' },
          { actionId: 'action-1', state: 'committed' },
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

  it('parses emitted fixture trace and rejects missing required trace fields', () => {
    const encoded = `${FRONTIER_TRACE_PREFIX}${JSON.stringify({ caseId: 'test-case', trace: trace() })}`;
    expect(parseFrontierTraceOutput(encoded, 'test-case')).toEqual(trace());
    expect(() =>
      parseFrontierTraceOutput(
        `${FRONTIER_TRACE_PREFIX}${JSON.stringify({ caseId: 'test-case', trace: { events: [] } })}`,
        'test-case',
      ),
    ).toThrow('fixture trace missing required fields for test-case');
    expect(() => parseFrontierTraceOutput('PASS without trace', 'test-case')).toThrow(
      'fixture emitted no machine-readable trace for test-case',
    );
  });
});
