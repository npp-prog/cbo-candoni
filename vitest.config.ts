import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Test configuration, kept separate from vite.config.ts.
 *
 * Vitest ships its own copy of Vite, and merging the two configs makes
 * TypeScript compare two structurally identical but nominally different
 * `Plugin` types and reject the result. The tests here are pure TypeScript -
 * the accounting invariants, money handling, dates and numbering - so they
 * need neither the React plugin nor PostCSS.
 */
export default defineConfig({
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
