import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['tests/vitest/setup.ts'],
    include: ['tests/vitest/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    testTimeout: 15_000,
  },
});
