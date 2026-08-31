import { describe, expect, it } from 'vitest';
import { ActionJournal } from '../../background/action-journal.js';
import type { ActionJournalEntry } from '../../background/run-types.js';

const prepared = {
  actionId: 'run-1:action:1',
  runId: 'run-1',
  toolCallId: 'call-1',
  tool: 'click',
  args: { selector: '#save' },
};

describe('ActionJournal', () => {
  it('makes duplicate commit idempotent', async () => {
    const journal = new ActionJournal();
    await journal.prepare(prepared);
    await journal.markInFlight(prepared.actionId);
    const first = await journal.commit(prepared.actionId, { success: true });
    const duplicate = await journal.commit(prepared.actionId, { success: true });
    expect(duplicate).toEqual(first);
  });

  it('reports dispatch only for first in-flight transition', async () => {
    const journal = new ActionJournal();
    await journal.prepare(prepared);
    const first = await journal.markInFlight(prepared.actionId);
    const duplicate = await journal.markInFlight(prepared.actionId);
    expect(first.shouldDispatch).toBe(true);
    expect(duplicate.shouldDispatch).toBe(false);
    expect(duplicate.entry.state).toBe('in_flight');
  });

  it('restores in-flight entries as ambiguous and never dispatchable', async () => {
    const restored: ActionJournalEntry = {
      actionId: prepared.actionId,
      runId: prepared.runId,
      toolCallId: prepared.toolCallId,
      tool: prepared.tool,
      argsDigest: 'digest',
      state: 'in_flight',
      startedAt: 10,
    };
    const journal = new ActionJournal([restored]);
    expect(journal.get(prepared.actionId)?.state).toBe('ambiguous');
    const attempt = await journal.markInFlight(prepared.actionId);
    expect(attempt.shouldDispatch).toBe(false);
  });

  it('persists prepared, in-flight, and committed states in order', async () => {
    const states: string[] = [];
    const journal = new ActionJournal([], async (entry) => states.push(entry.state));
    await journal.prepare(prepared);
    await journal.markInFlight(prepared.actionId);
    await journal.commit(prepared.actionId, { success: true });
    expect(states).toEqual(['prepared', 'in_flight', 'committed']);
  });
});
