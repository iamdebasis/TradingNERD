/**
 * The warm-up rule (docs/SPEC.md §6.16). A recursive average (`ta.rma`, `ta.ema`) depends on every
 * bar before it, and TradingView computes from its earliest bar. Ours starts at the first bar we
 * have loaded, so its first values differ from TradingView's until the bars we don't have weigh
 * less than SETTLED_WEIGHT. Until then they aren't drawn, unless our first bar is the pair's
 * listing, where TradingView's history starts too.
 *
 * 1e-9 of the difference between our seed and TradingView's: below a hundredth of a digit for an
 * RSI, and a thousandth of a cent on a 100,000-dollar price (ours, provisional, §11).
 */
export const SETTLED_WEIGHT = 1e-9;

/** Bars after its seed before a recursive average with this `alpha` has settled. */
export function settlingBars(alpha: number): number {
  if (!(alpha > 0) || alpha >= 1) return 0;
  return Math.ceil(Math.log(SETTLED_WEIGHT) / Math.log(1 - alpha));
}

/** `ta.rma(length)`'s settling bars. */
export const rmaSettling = (length: number): number => settlingBars(1 / length);

/** `ta.ema(length)`'s settling bars. */
export const emaSettling = (length: number): number => settlingBars(2 / (length + 1));
