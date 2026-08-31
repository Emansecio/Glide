import { describe, expect, it } from 'vitest';
import { chooseInputBackend } from '../../tools/input-backend.js';

describe('hybrid input backend policy', () => {
  it('defaults click and type to bridge', () => {
    expect(chooseInputBackend('click', {}, true)).toBe('bridge');
    expect(chooseInputBackend('type', {}, true)).toBe('bridge');
  });

  it('uses CDP for explicitly native hover and drag when enabled', () => {
    expect(chooseInputBackend('hover', { native: true }, true)).toBe('cdp');
    expect(chooseInputBackend('mouse', { action: 'drag', native: true }, true)).toBe('cdp');
  });

  it('returns permission-required policy result when debugger is disabled', () => {
    expect(chooseInputBackend('hover', { native: true }, false)).toEqual({
      error: 'NATIVE_INPUT_PERMISSION_REQUIRED',
    });
  });
});
