import type { MarketSchedule } from './schedule.ts';

/**
 * Where a market is in its day, as TradingView marks it (the legend's market status icon and
 * the watchlist's dots): in its regular session, before it (pre-market), after it until the
 * extended session ends (post-market), or closed (overnight, weekends and holidays).
 */
export type MarketStatus = 'open' | 'pre' | 'post' | 'closed';

export interface MarketStatusAt {
  status: MarketStatus;
  /** When the status next changes (ms); null for a market that never closes. */
  until: number | null;
}

/** The status of a market at `ms`; a market without a schedule (crypto) is always open. */
export function marketStatus(schedule: MarketSchedule | null, ms: number): MarketStatusAt {
  if (!schedule) return { status: 'open', until: null };
  const extended = schedule.sessionAtOrBefore(ms, 'extended');
  if (ms >= extended.close) {
    return { status: 'closed', until: schedule.sessionAfter(extended.day, 'extended').open };
  }
  const regular = schedule.session(extended.day, 'regular');
  if (!regular) return { status: 'closed', until: extended.close };
  if (ms < regular.open) return { status: 'pre', until: regular.open };
  if (ms < regular.close) return { status: 'open', until: regular.close };
  return { status: 'post', until: extended.close };
}
