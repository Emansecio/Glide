import { describe, expect, it } from 'vitest';
import { chooseInputBackend } from '../../tools/input-backend.js';

describe('hybrid input backend policy', () => {
  it('defaults click and type to bridge', () => {
    expect(chooseInputBackend('click', {})).toBe('bridge');
    expect(chooseInputBackend('type', {})).toBe('bridge');
    expect(chooseInputBackend('hover', {})).toBe('bridge');
  });

  it('uses CDP for explicitly native hover and drag without any opt-in', () => {
    expect(chooseInputBackend('hover', { native: true })).toBe('cdp');
    expect(chooseInputBackend('mouse', { action: 'drag', native: true })).toBe('cdp');
    expect(chooseInputBackend('mouse', { action: 'doubleClick', native: true })).toBe('bridge');
  });
});
