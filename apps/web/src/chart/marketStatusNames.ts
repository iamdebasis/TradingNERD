import type { MarketStatus } from '@tradingnerd/core';

/**
 * How each market status is named in tooltips: "Market closed" is TradingView's own (its
 * Charting Library's text key); the others are provisional (docs/SPEC.md §11).
 */
export const MARKET_STATUS_NAMES: Readonly<Record<MarketStatus, string>> = {
  open: 'Market open',
  pre: 'Pre-market',
  post: 'Post-market',
  closed: 'Market closed',
};
