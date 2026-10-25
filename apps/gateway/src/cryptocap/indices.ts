import type { Bar } from '@tradingnerd/core';
import type { CompositeName } from './symbols.ts';

/** TOTAL is the market cap of TradingView's top 125 coins. */
export const TOTAL_COINS = 125;
/** OTHERS leaves out the 10 largest. */
export const TOP_COINS = 10;
/** TOTALE50 and TOTALE100 leave out the top 50 and the top 100. */
export const E50_FROM = 50;
export const E100_FROM = 100;
/** STABLE.C is the market cap of up to 100 stablecoins. */
export const STABLE_COINS = 100;

/** CoinGecko's ids for the two coins TOTAL2 and TOTAL3 leave out. */
export const BITCOIN = 'bitcoin';
export const ETHEREUM = 'ethereum';

/** A bar's values without its time. */
export type CapBar = Omit<Bar, 'time' | 'start'>;

/** One coin's market cap over one bar, in US dollars. */
export interface CoinCapBar extends CapBar {
  id: string;
  stable: boolean;
}

const ZERO: CapBar = { open: 0, high: 0, low: 0, close: 0, volume: 0 };

function sum(coins: readonly CapBar[]): CapBar {
  const total = { ...ZERO };
  for (const coin of coins) {
    total.open += coin.open;
    total.high += coin.high;
    total.low += coin.low;
    total.close += coin.close;
    total.volume += coin.volume;
  }
  return total;
}

function minus(a: CapBar, b: CapBar | undefined): CapBar {
  if (!b) return a;
  return {
    open: a.open - b.open,
    high: a.high - b.high,
    low: a.low - b.low,
    close: a.close - b.close,
    volume: a.volume - b.volume,
  };
}

/** Largest close first; ties by id, so the same coins always give the same members. */
const byCap = (a: CoinCapBar, b: CoinCapBar) => b.close - a.close || a.id.localeCompare(b.id);

/**
 * Every composite's bar from the coins' bars of one period, as TradingView defines them (its
 * help center, docs/SPEC.md §4.11): TOTAL is the top 125 by market cap, TOTAL2 without Bitcoin,
 * TOTAL3 without Ethereum too, OTHERS without the top 10, the ES ones without stablecoins,
 * TOTALE50 and TOTALE100 ranks 51–125 and 101–125, STABLE.C the 100 largest stablecoins.
 *
 * The coins are ranked by their close. Open, high, low and close are each added up over the
 * same coins, as TradingView builds spread bars from their parts, so a composite's high is the
 * coins' highs together, which can run above the highest the composite itself reached.
 */
export function compositeBars(coins: readonly CoinCapBar[]): Record<CompositeName, CapBar> {
  const ranked = coins.filter((coin) => coin.close > 0).sort(byCap);
  const members = ranked.slice(0, TOTAL_COINS);
  const bitcoin = members.find((coin) => coin.id === BITCOIN);
  const ethereum = members.find((coin) => coin.id === ETHEREUM);
  const total = sum(members);
  const total2 = minus(total, bitcoin);
  const totalEs = sum(members.filter((coin) => !coin.stable));
  const total2Es = minus(totalEs, bitcoin?.stable ? undefined : bitcoin);
  return {
    TOTAL: total,
    TOTAL2: total2,
    TOTAL3: minus(total2, ethereum),
    OTHERS: sum(members.slice(TOP_COINS)),
    TOTALES: totalEs,
    TOTAL2ES: total2Es,
    TOTAL3ES: minus(total2Es, ethereum?.stable ? undefined : ethereum),
    TOTALE50: sum(members.slice(E50_FROM)),
    TOTALE100: sum(members.slice(E100_FROM)),
    'STABLE.C': sum(ranked.filter((coin) => coin.stable).slice(0, STABLE_COINS)),
  };
}

/**
 * `a` divided by `b` part by part, times `scale` (100 for a dominance): the open by the open,
 * the high by the high, and so on, as TradingView's spreads are built; the high and low are
 * then the largest and smallest of the four. Null when `b` has a part that isn't positive.
 */
export function divideBars(a: CapBar, b: CapBar, scale: number): CapBar | null {
  if (!(b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)) return null;
  const open = (a.open / b.open) * scale;
  const high = (a.high / b.high) * scale;
  const low = (a.low / b.low) * scale;
  const close = (a.close / b.close) * scale;
  return {
    open,
    high: Math.max(open, high, low, close),
    low: Math.min(open, high, low, close),
    close,
    volume: a.volume,
  };
}
