import { describe, expect, it } from 'vitest';
import { runUserScriptInPage } from '../../tools/execute-script-runner.js';

describe('runUserScriptInPage awaited legacy coverage', () => {
  it('returns values and side-effect nulls', async () => {
    await expect(runUserScriptInPage('return 42')).resolves.toMatchObject({ ok: true, value: 42 });
    await expect(runUserScriptInPage('1+1')).resolves.toMatchObject({ ok: true, value: 2 });
    await expect(runUserScriptInPage('var __glide_t=1')).resolves.toMatchObject({ ok: true, value: null });
  });

  it('awaits promises and top-level await', async () => {
    await expect(runUserScriptInPage('return Promise.resolve(7)')).resolves.toMatchObject({
      ok: true,
      value: 7,
      awaited: true,
    });
    await expect(runUserScriptInPage('return await Promise.resolve(9)')).resolves.toMatchObject({
      ok: true,
      value: 9,
    });
  });
});
