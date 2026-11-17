// The browser checks: a real Chromium against the real server and the demo data (test-browser/).
// Separate from vitest.config.ts so `npm test` stays fast and needs no browser or built web app.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test-browser/globalSetup.ts'],
    include: ['test-browser/**/*.test.ts'],
    // One browser, one server, one database: these checks share state on purpose and must not run side by side.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
