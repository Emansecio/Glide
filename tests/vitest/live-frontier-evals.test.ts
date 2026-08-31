import { describe, expect, it, vi } from 'vitest';
import { runLiveFrontierEvals } from '../evals/run-live-frontier-evals.js';

describe('live frontier eval environment gate', () => {
  it('returns documented skip status without launching browser when disabled', async () => {
    const execute = vi.fn();

    await expect(runLiveFrontierEvals({ env: {}, execute })).resolves.toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([0, 1, 7])('propagates enabled child status %s exactly', async (status) => {
    const execute = vi.fn().mockResolvedValue(status);

    await expect(runLiveFrontierEvals({ env: { GLIDE_LIVE_TESTS: '1' }, execute })).resolves.toBe(status);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
