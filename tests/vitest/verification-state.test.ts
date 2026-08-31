import { describe, expect, it } from 'vitest';
import { VerificationState } from '../../background/verification-state.js';

const effect = {
  actionId: 'run-1:action:1',
  tool: 'click',
  tabId: 7,
  frameId: 0,
  domRevision: 3,
  navigationRevision: 1,
};

describe('VerificationState', () => {
  it('does not create pending verification for wait', () => {
    const state = new VerificationState();
    state.recordObservation({ tool: 'wait', tabId: 7, frameId: 0, domRevision: 4, navigationRevision: 1 });
    expect(state.pending()).toBeNull();
  });

  it('clears pending with newer same-tab/frame observation', () => {
    const state = new VerificationState();
    state.recordEffect(effect);
    expect(
      state.recordObservation({ tool: 'readPage', tabId: 7, frameId: 0, domRevision: 4, navigationRevision: 1 }),
    ).toMatchObject({ verified: true });
    expect(state.pending()).toBeNull();
  });

  it('does not clear from another frame or stale revision', () => {
    const state = new VerificationState();
    state.recordEffect(effect);
    expect(
      state.recordObservation({ tool: 'readPage', tabId: 7, frameId: 2, domRevision: 5, navigationRevision: 1 }),
    ).toMatchObject({ verified: false });
    expect(
      state.recordObservation({ tool: 'readPage', tabId: 7, frameId: 0, domRevision: 3, navigationRevision: 1 }),
    ).toMatchObject({ verified: false });
    expect(state.pending()?.actionId).toBe(effect.actionId);
  });

  it('successful declared postcondition clears automatically', () => {
    const state = new VerificationState();
    state.recordEffect({ ...effect, postconditionSatisfied: true });
    expect(state.pending()).toBeNull();
  });
});
