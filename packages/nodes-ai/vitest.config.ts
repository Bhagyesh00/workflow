import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
    testTimeout: 20000,
    // Postgres and Redis backed tests share the ai_test database and Redis db 2
    fileParallelism: false,
  },
});
