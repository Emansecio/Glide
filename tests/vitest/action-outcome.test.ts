import { describe, expect, it, vi } from 'vitest';
import { ActionJournal, classifyActionOutcome, isMutativeBrowserEffect } from '../../background/action-journal.js';
import { RunCoordinator } from '../../background/run-coordinator.js';

const prepared = {
  actionId: 'run-1:action:1',
  runId: 'run-1',
  toolCallId: 'call-1',
  tool: 'click',
  args: { selector: '#save' },
};

describe('journaled action outcome certainty', () => {
  it('classifies argument-dependent HTTP and download mutations', () => {
    for (const method of ['POST', 'put', 'Patch', 'DELETE']) {
      expect(isMutativeBrowserEffect('httpRequest', { method })).toBe(true);
    }
    expect(isMutativeBrowserEffect('httpRequest', {})).toBe(false);
    expect(isMutativeBrowserEffect('httpRequest', { method: 'GET' })).toBe(false);
    expect(isMutativeBrowserEffect('httpRequest', { method: 'HEAD' })).toBe(false);

    expect(isMutativeBrowserEffect('captureDownload', { url: 'https://example.com/report.csv' })).toBe(true);
    expect(isMutativeBrowserEffect('captureDownload', { trigger: { selector: '#export' } })).toBe(true);
    expect(isMutativeBrowserEffect('captureDownload', { urlPattern: '.csv' })).toBe(false);
    expect(isMutativeBrowserEffect('captureDownload', { trigger: { selector: '  ' } })).toBe(false);
  });

  it('marks a delayed unknown mutation ambiguous and terminal without replay', async () => {
    vi.useFakeTimers();
    const coordinator = new RunCoordinator();
    coordinator.start(
      { runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1' },
      { contextRevision: 0, selectedTabIds: [7], request: { message: 'click once' } },
    );
    coordinator.transition('run-1', 'model');
    const persistedStates: string[] = [];
    const journal = new ActionJournal([], async (entry) => {
      persistedStates.push(entry.state);
      await coordinator.recordAction(entry);
    });
    let mutations = 0;
    const dispatch = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(() => {
            mutations += 1;
          }, 25);
          setTimeout(
            () =>
              resolve({
                success: false,
                code: 'BRIDGE_TIMEOUT',
                timedOut: true,
                outcomeCertainty: 'unknown',
              }),
            50,
          );
        }),
    );

    await journal.prepare(prepared);
    const inFlight = await journal.markInFlight(prepared.actionId);
    expect(inFlight.shouldDispatch).toBe(true);
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    const outcomeCertainty = classifyActionOutcome(result);
    const settled = await journal.markAmbiguous(prepared.actionId);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mutations).toBe(1);
    expect(outcomeCertainty).toBe('unknown');
    expect(settled.state).toBe('ambiguous');
    expect(persistedStates).toEqual(['prepared', 'in_flight', 'ambiguous']);
    expect(coordinator.get('run-1')).toMatchObject({
      phase: 'ambiguous',
      terminalReason: 'ambiguous_action',
      inFlightAction: { state: 'ambiguous' },
    });
    vi.useRealTimers();
  });

  it('commits conclusive failure outcomes', async () => {
    const journal = new ActionJournal();
    await journal.prepare(prepared);
    const inFlight = await journal.markInFlight(prepared.actionId);
    expect(inFlight.shouldDispatch).toBe(true);
    const result = {
      success: false,
      code: 'STALE_ELEMENT_HANDLE',
      outcomeCertainty: 'known_not_executed',
    } as const;
    expect(classifyActionOutcome(result)).toBe('known_not_executed');
    const settled = await journal.commit(prepared.actionId, result);

    expect(settled.state).toBe('committed');
  });
});
