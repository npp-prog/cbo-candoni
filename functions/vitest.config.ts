import { defineConfig } from 'vitest/config';

/**
 * A config of its own so that vitest does not walk up and load the frontend's
 * vite.config.ts, which pulls in the React plugin this package does not have.
 */
export default defineConfig({
  // Tests here are plain TypeScript with no CSS; disabling PostCSS stops vite
  // from walking up into the frontend's Tailwind config, which this package
  // does not install.
  css: { postcss: { plugins: [] } },
  test: {
    root: __dirname,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
