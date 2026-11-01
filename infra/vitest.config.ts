import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file synthesizes whole stacks in beforeAll, which takes a while with files in parallel.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
