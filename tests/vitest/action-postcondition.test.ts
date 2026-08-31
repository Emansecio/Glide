import { describe, expect, it, vi } from 'vitest';
import { verifyActionPostcondition } from '../../tools/action-postcondition.js';

describe('action postconditions', () => {
  it('returns matching evidence as verified', async () => {
    const result = await verifyActionPostcondition(
      { kind: 'checked', selector: '#agree', value: true },
      async () => ({ checked: true }),
      { timeoutMs: 100 },
    );
    expect(result).toMatchObject({ verified: true, evidence: { checked: true } });
  });

  it('returns observed state on timeout without replaying action', async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockResolvedValue({ visible: false });
    const pending = verifyActionPostcondition(
      { kind: 'visible', selector: '#done' },
      observe,
      { timeoutMs: 50, pollMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toMatchObject({
      verified: false,
      code: 'POSTCONDITION_FAILED',
      observed: { visible: false },
    });
    expect(observe).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
