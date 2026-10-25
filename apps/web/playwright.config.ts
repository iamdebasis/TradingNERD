import { defineConfig, type Project } from '@playwright/test';
import { GATEWAY_DEFAULT_PORT, WEB_DEV_PORT } from '@tradingnerd/core';

/** Matches the reference screenshot's layout width (docs/SPEC.md §7.2), at Retina scale. */
const viewport = { width: 1634, height: 1000 };

/**
 * Normal runs mock all market data in the browser and must never reach an exchange: a gateway
 * started here gets unreachable endpoints for every exchange. LIVE=1 (`pnpm test:e2e:live`) runs only the
 * @live tests, against real Binance.
 */
const live = process.env.LIVE === '1';
const nowhere = { rest: 'http://127.0.0.1:9', stream: 'ws://127.0.0.1:9' };
const offlineExchanges = Object.fromEntries(
  ['BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'KRAKEN', 'BITSTAMP'].flatMap((exchange) => [
    [`${exchange}_REST_URL`, nowhere.rest],
    [`${exchange}_STREAM_URL`, nowhere.stream],
  ]),
);
offlineExchanges.OKX_BUSINESS_STREAM_URL = nowhere.stream;
// US stocks: Alpaca's hosts and Nasdaq's symbol directory, unreachable too.
offlineExchanges.ALPACA_DATA_URL = nowhere.rest;
offlineExchanges.ALPACA_TRADING_URL = nowhere.rest;
offlineExchanges.ALPACA_STREAM_URL = nowhere.stream;
offlineExchanges.US_LISTINGS_URL = `${nowhere.rest}/`;

/**
 * Not devices['Desktop Chrome']: its Windows user agent would switch on the Windows wheel
 * handling. This matches the Mac the app is built on.
 */
const chromium: Project['use'] = {
  browserName: 'chromium',
  viewport,
  deviceScaleFactor: 2,
  // Emulated 2× alone leaves ResizeObserver reporting 1× sizes, so charts would render blurry
  // at half resolution; a real 2× device scale matches a Retina Mac.
  launchOptions: { args: ['--force-device-scale-factor=2'] },
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  ...(live ? { grep: /@live/ } : { grepInvert: /@live/ }),
  use: {
    baseURL: `http://127.0.0.1:${WEB_DEV_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: chromium, testIgnore: /perf\.spec\.ts$/ },
    // Timing budgets run alone, after everything else, so parallel tests can't skew them.
    { name: 'perf', use: chromium, testMatch: /perf\.spec\.ts$/, dependencies: ['chromium'] },
  ],
  webServer: [
    {
      command: 'node src/main.ts',
      cwd: '../gateway',
      url: `http://127.0.0.1:${GATEWAY_DEFAULT_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: live ? {} : offlineExchanges,
    },
    {
      command: 'pnpm exec vite',
      url: `http://127.0.0.1:${WEB_DEV_PORT}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
