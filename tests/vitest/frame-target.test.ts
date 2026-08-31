import { describe, expect, it } from 'vitest';
import { resolveUniqueSelectorFrame } from '../../tools/frame-target.js';

describe('single-frame mutation targeting', () => {
  it('returns the only frame matching a selector', () => {
    expect(resolveUniqueSelectorFrame([{ frameId: 0, matched: false }, { frameId: 4, matched: true }])).toEqual({
      ok: true,
      frameId: 4,
    });
  });

  it('fails closed when a selector matches multiple frames', () => {
    expect(
      resolveUniqueSelectorFrame([
        { frameId: 0, matched: true },
        { frameId: 4, matched: true },
      ]),
    ).toMatchObject({ ok: false, code: 'FRAME_AMBIGUOUS' });
  });

  it('reports missing selectors without selecting a mutation frame', () => {
    expect(resolveUniqueSelectorFrame([{ frameId: 0, matched: false }])).toMatchObject({
      ok: false,
      code: 'ELEMENT_NOT_FOUND',
    });
  });
});
