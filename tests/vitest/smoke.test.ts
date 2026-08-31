import { describe, expect, it } from 'vitest';
import { normalizePlanStatus } from '../../types/plan.js';

describe('vitest foundation', () => {
  it('loads project TypeScript modules', () => {
    expect(normalizePlanStatus('done')).toBe('done');
  });
});
