import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Reuse worker processes across test files instead of spawning one pool
    // per file — the suites are pure/deterministic, so this shaves several
    // seconds off `npm test` with no loss of isolation guarantees.
    pool: 'threads',
    isolate: false,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/imaging/**', 'src/persistence/**'],
    },
  },
});
