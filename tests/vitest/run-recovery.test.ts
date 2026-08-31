import { describe, expect, it } from 'vitest';
import { recoverCheckpoint } from '../../background/run-recovery.js';
import type { RunCheckpoint } from '../../background/run-types.js';

const checkpoint = (phase: RunCheckpoint['phase']): RunCheckpoint => ({
  version: 1,
  runId: 'run-old',
  sessionId: 'session-1',
  turnId: 'turn-1',
  phase,
  contextRevision: 4,
  selectedTabIds: [5],
  request: { message: 'inspect page' },
  startedAt: 100,
  updatedAt: 200,
});

describe('recoverCheckpoint', () => {
  it.each(['model', 'committing'] as const)('resumes safe %s checkpoint with committed revision', (phase) => {
    expect(recoverCheckpoint(checkpoint(phase), { committedContextRevision: 4, now: 300 })).toBe('resume');
  });

  it('requires confirmation for an in-flight action', () => {
    const state = {
      ...checkpoint('action_in_flight'),
      inFlightAction: {
        actionId: 'run-old:action:1',
        runId: 'run-old',
        tool: 'click',
        argsDigest: 'digest',
        state: 'in_flight' as const,
        startedAt: 150,
      },
    };
    expect(recoverCheckpoint(state, { committedContextRevision: 4, now: 300 })).toBe('confirm');
  });

  it('discards terminal, stale, and revision-mismatched checkpoints', () => {
    expect(recoverCheckpoint(checkpoint('completed'), { committedContextRevision: 4, now: 300 })).toBe('discard');
    expect(recoverCheckpoint(checkpoint('model'), { committedContextRevision: 4, now: 8 * 24 * 60 * 60 * 1000 })).toBe(
      'discard',
    );
    expect(recoverCheckpoint(checkpoint('model'), { committedContextRevision: 3, now: 300 })).toBe('discard');
  });
});
