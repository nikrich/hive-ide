/**
 * Vitest config for the renderer-side test suite.
 *
 * The renderer is a Vite + React app, so we mirror its alias setup here.
 * `happy-dom` provides a DOM globals environment cheap enough to run
 * per-file; the workspace store doesn't need React rendering yet, but
 * future store tests (e.g. with React Testing Library) will inherit this.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
})
