import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // mock-fs patches process-global fs internals; serialising test files
    // keeps a botched restore from leaving the rest of the suite reading
    // a half-mocked filesystem.
    fileParallelism: false,
  },
});
