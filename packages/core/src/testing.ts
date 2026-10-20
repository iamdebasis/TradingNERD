import type { MarketScheduleData } from './schedule.ts';

/**
 * Fixtures for tests across the packages (`@tradingnerd/core/testing`); not part of the app.
 */

/** The NYSE's 2026 calendar: its holidays and 13:00 closes. */
export const NYSE_2026: MarketScheduleData = {
  timezone: 'America/New_York',
  regular: [570, 960],
  extended: [240, 1200],
  from: '2026-01-02',
  to: '2026-12-31',
  holidays: [
    '2026-01-19',
    '2026-02-16',
    '2026-04-03',
    '2026-05-25',
    '2026-06-19',
    '2026-07-03',
    '2026-09-07',
    '2026-11-26',
    '2026-12-25',
  ],
  special: { '2026-11-27': [570, 780], '2026-12-24': [570, 780] },
};
