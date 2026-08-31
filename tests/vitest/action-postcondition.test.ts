import { describe, expect, it, vi } from 'vitest';
import { verifyActionPostcondition } from '../../tools/action-postcondition.js';
import { getToolPostconditionDurationMs } from '../../tools/browser-tools.js';

describe('action postconditions', () => {
  it('returns matching evidence as verified', async () => {
    const result = await verifyActionPostcondition(
      { kind: 'checked', selector: '#agree', value: true },
      async () => ({ checked: true }),
      { timeoutMs: 100 },
    );
    expect(result).toMatchObject({ verified: true, evidence: { checked: true } });
  });

  it('does not verify an unchanged URL when from is omitted', async () => {
    vi.useFakeTimers();
    const pending = verifyActionPostcondition({ kind: 'url_changed' }, () => ({ url: 'https://example.test/start' }), {
      baselineUrl: 'https://example.test/start',
      timeoutMs: 20,
      pollMs: 10,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toMatchObject({
      verified: false,
      code: 'POSTCONDITION_FAILED',
      postcondition: { kind: 'url_changed', from: 'https://example.test/start' },
      observed: { url: 'https://example.test/start' },
    });
    vi.useRealTimers();
  });

  it('verifies a SPA URL transition', async () => {
    let revision = 8;
    const result = await verifyActionPostcondition(
      { kind: 'url_changed' },
      async () => {
        revision += 1;
        return { url: 'https://example.test/next' };
      },
      { baselineUrl: 'https://example.test/start', timeoutMs: 100 },
    );
    expect(result.verified).toBe(true);
    expect(revision).toBe(9);
  });

  it('returns observed state on timeout without replaying action', async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockResolvedValue({ visible: false });
    const pending = verifyActionPostcondition({ kind: 'visible', selector: '#done' }, observe, {
      timeoutMs: 50,
      pollMs: 20,
    });
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toMatchObject({
      verified: false,
      code: 'POSTCONDITION_FAILED',
      observed: { visible: false },
      postcondition: { durationMs: 50 },
    });
    expect(observe).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reports actual polling time through browser-tool telemetry seam', async () => {
    vi.useFakeTimers();
    let observations = 0;
    const pending = verifyActionPostcondition(
      { kind: 'visible', selector: '#ready' },
      () => ({ visible: ++observations >= 3 }),
      { timeoutMs: 100, pollMs: 20 },
    );

    await vi.advanceTimersByTimeAsync(40);
    const result = await pending;

    expect(result).toMatchObject({ verified: true, postcondition: { durationMs: 40 } });
    expect(getToolPostconditionDurationMs(result)).toBe(40);
    expect(getToolPostconditionDurationMs({ success: true })).toBe(0);
    vi.useRealTimers();
  });
});
