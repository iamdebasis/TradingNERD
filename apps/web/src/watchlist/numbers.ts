import { formatPrice } from '@tradingnerd/chart';

/** TradingView prints negative numbers with a true minus sign, not a hyphen. */
const MINUS = '−';

/** The most decimals Chg shows; further digits are cut, not rounded. */
export const CHANGE_DECIMALS = 5;

/**
 * A change as the watchlist shows it: "−0.403", "0.0101" (no plus sign), "0.0000". A coin
 * priced to more than 5 decimals gets 5, cut rather than rounded, with the real change's sign.
 * In the reference, VET at 0.006731 shows −0.00024 at −3.55%, which only a change of −0.000248
 * gives, and SHIB shows −0.00000.
 */
export function formatChange(value: number, precision: number): string {
  const exact = Math.abs(value).toFixed(precision);
  const cut = precision - CHANGE_DECIMALS;
  const text = groupThousands(cut > 0 ? exact.slice(0, -cut) : exact);
  return directionOf(value, precision) === 'down' ? `${MINUS}${text}` : text;
}

/** The last price as the watchlist shows it: the symbol's decimals, thousands grouped. */
export function formatLast(value: number, precision: number): string {
  return groupThousands(formatPrice(value, precision));
}

/**
 * Whole digits in groups of three, as TradingView's watchlist prints them: ZEC at "1,147.903"
 * in docs/reference/05-watchlist-hover.png. A leading sign stays in front.
 */
export function groupThousands(text: string): string {
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? '' : text.slice(dot);
  return whole.replace(/\B(?=(\d{3})+$)/g, ',') + rest;
}

export function formatChangePercent(value: number): string {
  return `${formatChange(value, 2)}%`;
}

/** Up, down or flat, for coloring a change. */
export type Direction = 'up' | 'down' | 'flat';

export function directionOf(value: number, precision: number): Direction {
  if (Number(Math.abs(value).toFixed(precision)) === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

export interface FlashSplit {
  /** The leading characters that didn't change. */
  same: string;
  /** The trailing characters that did, shown in the tick's color. */
  changed: string;
  direction: Direction;
}

/**
 * How TradingView's watchlist shows a new last price: the digits from the first one that
 * changed onward take the tick's color (green up, red down), the rest stay plain.
 */
export function flashSplit(previous: string | null, next: string, delta: number): FlashSplit {
  if (previous === null || previous === next) return { same: next, changed: '', direction: 'flat' };
  let common = 0;
  while (common < next.length && previous[common] === next[common]) common++;
  return {
    same: next.slice(0, common),
    changed: next.slice(common),
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
  };
}
