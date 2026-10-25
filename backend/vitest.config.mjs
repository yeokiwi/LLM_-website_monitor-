import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // The backend is CommonJS; globals let the suites stay `require`-based
    // rather than forcing an ESM/CJS split just for the test API.
    globals: true,
    // Each suite owns a database file and mutates process.env before loading
    // the app, so suites must not share a worker or run in parallel.
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    fileParallelism: false,
    testTimeout: 20000,
  },
});
