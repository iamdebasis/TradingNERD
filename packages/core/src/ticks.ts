import type { Bar } from './market.ts';

/**
 * Tick bars: each bar holds a fixed number of trades. Exchanges number their trades, so bar k
 * of an n-tick chart holds trades k·n … k·n + n − 1: the bars stay the same however far back
 * history is loaded, and `time` (the bar's number) increases strictly as charts need.
 */

/** One aggregate trade: trades `firstId` … `lastId` (inclusive), all at one price. */
export interface AggTrade {
  /** The aggregate's own id. */
  id: number;
  firstId: number;
  lastId: number;
  price: number;
  /** Total quantity of its trades. */
  quantity: number;
  /** Epoch ms. */
  time: number;
}

/** The number of the n-tick bar holding trade `tradeId`. */
export function tickBarOf(tradeId: number, ticks: number): number {
  return Math.floor(tradeId / ticks);
}

/**
 * Adds an aggregate trade's ticks to ascending `bars` (the last may be unfinished), counting
 * only trades below `beforeTradeId`, and returns the bars it touched. An aggregate's quantity
 * is shared evenly by its trades, since exchanges don't report each one's.
 */
export function addTicks(
  bars: Bar[],
  trade: AggTrade,
  ticks: number,
  beforeTradeId = Number.POSITIVE_INFINITY,
): Bar[] {
  const touched: Bar[] = [];
  const trades = trade.lastId - trade.firstId + 1;
  const last = Math.min(trade.lastId, beforeTradeId - 1);
  for (let first = trade.firstId; first <= last; ) {
    const index = tickBarOf(first, ticks);
    const end = Math.min(last, (index + 1) * ticks - 1);
    const volume = (trade.quantity * (end - first + 1)) / trades;
    let bar = bars.at(-1);
    if (bar && bar.time === index) {
      bar.high = Math.max(bar.high, trade.price);
      bar.low = Math.min(bar.low, trade.price);
      bar.close = trade.price;
      bar.volume += volume;
    } else if (!bar || index > bar.time) {
      bar = {
        time: index,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume,
        start: trade.time,
      };
      bars.push(bar);
    } else {
      bar = undefined; // older than what's there: out of order, ignored
    }
    if (bar && !touched.includes(bar)) touched.push(bar);
    first = end + 1;
  }
  return touched;
}

/** Folds ascending aggregate trades into n-tick bars, counting trades below `beforeTradeId`. */
export function foldTicks(
  trades: readonly AggTrade[],
  ticks: number,
  beforeTradeId = Number.POSITIVE_INFINITY,
): Bar[] {
  const bars: Bar[] = [];
  for (const trade of trades) addTicks(bars, trade, ticks, beforeTradeId);
  return bars;
}
