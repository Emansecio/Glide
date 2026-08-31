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
  expectedTerminalReason: 'completed',
  expectedEffects: {
    events: 1,
    mutations: 1,
    committedAttempts: 1,
    allowedActionTransitions: [['committed']],
  },
};

const trace = (overrides: Partial<FrontierEvalTrace> = {}): FrontierEvalTrace => ({
  events: [
    {
      source: 'production_runtime',
      id: 'event-1',
      actionId: 'action-1',
      kind: 'click',
      frameId: 2,
    },
  ],
  mutations: [
    {
      source: 'fixture_state',
      actionId: 'action-1',
      requestedFrameId: 2,
      actualFrameId: 2,
      handleState: 'fresh',
    },
  ],
  actionAttempts: [{ source: 'production_runtime', actionId: 'action-1', state: 'committed' }],
  contextRevisions: [{ source: 'production_runtime', revision: 4 }],
  terminal: { source: 'production_runtime', reason: 'completed' },
  ...overrides,
});

describe('frontier invariant grader', () => {
  it('passes evidence derived from production runtime and fixture state', () => {
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
      'multiple unique events',
      trace({
        events: [
          { source: 'production_runtime', id: 'first', kind: 'click' },
          { source: 'production_runtime', id: 'second', kind: 'click' },
        ],
      }),
      'event count 2; expected 1',
    ],
    [
      'multiple mutations',
      trace({
        mutations: [
          {
            source: 'fixture_state',
            actionId: 'action-1',
            requestedFrameId: 2,
            actualFrameId: 2,
            handleState: 'fresh',
          },
          {
            source: 'fixture_state',
            actionId: 'action-2',
            requestedFrameId: 2,
            actualFrameId: 2,
            handleState: 'fresh',
          },
        ],
      }),
      'mutation count 2; expected 1',
    ],
    [
      'multiple committed attempts',
      trace({
        actionAttempts: [
          { source: 'production_runtime', actionId: 'action-1', state: 'committed' },
          { source: 'production_runtime', actionId: 'action-2', state: 'committed' },
        ],
      }),
      'committed attempt count 2; expected 1',
    ],
    [
      'cross-frame mutation',
      trace({
        mutations: [
          {
            source: 'fixture_state',
            actionId: 'action-1',
            requestedFrameId: 2,
            actualFrameId: 7,
            handleState: 'fresh',
          },
        ],
      }),
      'cross-frame mutation',
    ],
    [
      'stale-handle mutation',
      trace({
        mutations: [
          {
            source: 'fixture_state',
            actionId: 'action-1',
            requestedFrameId: 2,
            actualFrameId: 2,
            handleState: 'stale',
          },
        ],
      }),
      'stale handle mutated',
    ],
    [
      'post-ambiguous replay',
      trace({
        actionAttempts: [
          { source: 'production_runtime', actionId: 'action-1', state: 'ambiguous' },
          { source: 'production_runtime', actionId: 'action-1', state: 'committed' },
        ],
      }),
      'ambiguous action replayed',
    ],
    ['missing context revision', trace({ contextRevisions: [] }), 'missing context revision'],
    [
      'wrong terminal reason',
      trace({ terminal: { source: 'production_runtime', reason: 'failed' } }),
      'terminal reason failed; expected completed',
    ],
    [
      'self-declared action state',
      trace({ actionAttempts: [{ source: 'test_literal' as never, actionId: 'action-1', state: 'committed' }] }),
      'untrusted trace source',
    ],
  ])('fails on %s', (_name, input, expectedFailure) => {
    const grade = gradeFrontierCase(evalCase, input);
    expect(grade.passed).toBe(false);
    expect(grade.failures).toContain(expectedFailure);
  });

  it('parses trusted fixture trace and rejects self-declared orchestration fields', () => {
    const encoded = `${FRONTIER_TRACE_PREFIX}${JSON.stringify({ caseId: 'test-case', trace: trace() })}`;
    expect(parseFrontierTraceOutput(encoded, 'test-case')).toEqual(trace());
    expect(() =>
      parseFrontierTraceOutput(
        `${FRONTIER_TRACE_PREFIX}${JSON.stringify({
          caseId: 'test-case',
          trace: { ...trace(), actionAttempts: [{ actionId: 'literal', state: 'committed' }] },
        })}`,
        'test-case',
      ),
    ).toThrow('fixture trace contains untrusted evidence for test-case');
    expect(() => parseFrontierTraceOutput('PASS without trace', 'test-case')).toThrow(
      'fixture emitted no machine-readable trace for test-case',
    );
  });
});
