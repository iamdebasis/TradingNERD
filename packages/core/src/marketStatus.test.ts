import { describe, expect, it } from 'vitest';
import { marketStatus } from './marketStatus.ts';
import { MarketSchedule } from './schedule.ts';
import { NYSE_2026 } from './testing.ts';

const nyse = new MarketSchedule(NYSE_2026);
const at = (iso: string) => Date.parse(iso);
const statusAt = (iso: string) => {
  const { status, until } = marketStatus(nyse, at(iso));
  return { status, until: until === null ? null : new Date(until).toISOString() };
};

describe('market status', () => {
  it('follows a US trading day: pre-market, open, post-market, then closed', () => {
    // Monday 19 October 2026, New York time (UTC−4).
    expect(statusAt('2026-10-19T07:59:00Z')).toEqual({
      status: 'closed',
      until: '2026-10-19T08:00:00.000Z',
    });
    expect(statusAt('2026-10-19T08:00:00Z')).toEqual({
      status: 'pre',
      until: '2026-10-19T13:30:00.000Z',
    });
    expect(statusAt('2026-10-19T13:30:00Z')).toEqual({
      status: 'open',
      until: '2026-10-19T20:00:00.000Z',
    });
    expect(statusAt('2026-10-19T20:00:00Z')).toEqual({
      status: 'post',
      until: '2026-10-20T00:00:00.000Z',
    });
    expect(statusAt('2026-10-20T00:00:00Z')).toEqual({
      status: 'closed',
      until: '2026-10-20T08:00:00.000Z',
    });
  });

  it('is closed over weekends and holidays, until the next pre-market', () => {
    // Friday evening to Monday's 04:00.
    expect(statusAt('2026-10-17T15:00:00Z')).toEqual({
      status: 'closed',
      until: '2026-10-19T08:00:00.000Z',
    });
    // Thanksgiving: Friday's pre-market is next.
    expect(statusAt('2026-11-26T15:00:00Z')).toEqual({
      status: 'closed',
      until: '2026-11-27T09:00:00.000Z',
    });
  });

  it('moves the post-market with an early close', () => {
    // 27 November: the regular session closes at 13:00, after-hours trading at 17:00 (UTC−5).
    expect(statusAt('2026-11-27T18:00:00Z')).toEqual({
      status: 'post',
      until: '2026-11-27T22:00:00.000Z',
    });
  });

  it('is always open for a market without sessions', () => {
    expect(marketStatus(null, at('2026-10-17T15:00:00Z'))).toEqual({ status: 'open', until: null });
  });
});
