import { expect, it } from 'vitest';
import { runChild } from '../../scripts/run-child.mjs';

it('returns non-zero child status', () => {
  expect(runChild(['-e', 'process.exit(7)'], {})).toBe(7);
});
