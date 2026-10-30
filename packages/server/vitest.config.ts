import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
    // all test files share one Postgres database and Redis db index: run them one at a time
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: { NODE_ENV: 'test' },
  },
});
