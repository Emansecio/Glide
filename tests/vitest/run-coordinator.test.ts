import { describe, expect, it } from 'vitest';
import { RunCoordinator } from '../../background/run-coordinator.js';
import type { RunMeta, RunResumeInput } from '../../background/run-types.js';

const meta: RunMeta = { runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1' };
const input: RunResumeInput = {
  contextRevision: 2,
  selectedTabIds: [7],
  request: { message: 'do work', panelTabId: 3 },
};

describe('RunCoordinator', () => {
  it('rejects transitions out of completed and stopped states', () => {
    const coordinator = new RunCoordinator();
    coordinator.start(meta, input);
    coordinator.transition(meta.runId, 'model');
    coordinator.transition(meta.runId, 'completed');
    expect(() => coordinator.transition(meta.runId, 'model')).toThrow(/Invalid run transition/);

    const stopped = { ...meta, runId: 'run-2' };
    coordinator.start(stopped, input);
    coordinator.transition(stopped.runId, 'stopped');
    expect(() => coordinator.transition(stopped.runId, 'committing')).toThrow(/Invalid run transition/);
  });

  it('allows in-flight ambiguity and model completion', () => {
    const coordinator = new RunCoordinator();
    coordinator.start(meta, input);
    coordinator.transition(meta.runId, 'model');
    coordinator.transition(meta.runId, 'action_prepared');
    coordinator.transition(meta.runId, 'action_in_flight');
    expect(coordinator.transition(meta.runId, 'ambiguous').phase).toBe('ambiguous');

    const completed = { ...meta, runId: 'run-3' };
    coordinator.start(completed, input);
    coordinator.transition(completed.runId, 'model');
    expect(coordinator.transition(completed.runId, 'completed').phase).toBe('completed');
  });

  it('records terminal reason and returns defensive state copies', () => {
    const coordinator = new RunCoordinator();
    coordinator.start(meta, input);
    coordinator.transition(meta.runId, 'model');
    const terminal = coordinator.terminal(meta.runId, 'awaiting_user');
    expect(terminal).toMatchObject({ phase: 'awaiting_user', terminalReason: 'awaiting_user' });
    terminal.selectedTabIds.push(99);
    expect(coordinator.get(meta.runId)?.selectedTabIds).toEqual([7]);
  });
});
