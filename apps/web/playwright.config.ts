import { defineConfig, devices } from '@playwright/test';
import { GATEWAY_DEFAULT_PORT, WEB_DEV_PORT } from '@tradingnerd/core';

/** Matches the reference screenshot's layout width (docs/SPEC.md §7.2), at Retina scale. */
const viewport = { width: 1634, height: 1000 };

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_DEV_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport, deviceScaleFactor: 2 },
    },
  ],
  webServer: [
    {
      command: 'node src/main.ts',
      cwd: '../gateway',
      url: `http://127.0.0.1:${GATEWAY_DEFAULT_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm exec vite',
      url: `http://127.0.0.1:${WEB_DEV_PORT}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
