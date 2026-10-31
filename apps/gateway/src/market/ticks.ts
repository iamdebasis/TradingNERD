import { type AggTrade, addTicks, type Bar, type BarsResponse, foldTicks } from '@tradingnerd/core';
import { mapLimit } from './concurrency.ts';
import type { BarChange } from './liveBar.ts';
import type { TickSource, Trade } from './types.ts';

/** Requests one tick-history call may make (about 40,000 trades on Binance), 6 at a time. */
export const TICK_MAX_REQUESTS = 12;
const TICK_CONCURRENCY = 6;
/** Anchors remembered per symbol; older ones are forgotten first. */
const MAX_ANCHORS = 500;

/**
 * Tick-bar history. Exchanges page their aggregate trades by aggregate id, while tick bars are
 * cut by trade id. So each page remembers which aggregate holds the trade just before its
 * oldest bar, and the next page back starts right there. Without that anchor (after a restart,
 * say) the exchange is asked which aggregate holds the trade.
 */
export class TickHistory {
  /** Per symbol: trade id → id of the aggregate holding the trade just before it. */
  private readonly anchors = new Map<string, Map<number, number>>();

  /**
   * Up to `countBack` bars of `ticks` trades numbered below `toIndex` (the latest bars when
   * null, the live one included).
   */
  async bars(
    source: TickSource,
    symbol: string,
    ticker: string,
    ticks: number,
    toIndex: number | null,
    countBack: number,
  ): Promise<BarsResponse> {
    const before = toIndex === null ? Number.POSITIVE_INFINITY : toIndex * ticks;
    const pages: AggTrade[][] = [];
    let next: number; // the highest aggregate id still to fetch
    if (toIndex === null) {
      const latest = await source.aggTrades(ticker, null, source.maxPerRequest);
      const oldest = latest[0];
      if (!oldest) return { bars: [], hasMore: false, fromListing: false };
      pages.push(latest);
      next = oldest.id - 1;
    } else {
      const anchor =
        this.anchors.get(symbol)?.get(before) ??
        (await source.aggTradeContaining(ticker, before - 1))?.id;
      if (anchor === undefined) return { bars: [], hasMore: false, fromListing: false };
      next = anchor;
    }

    const wanted = (countBack + 1) * ticks;
    let reachedStart = false;
    for (let requests = pages.length; requests < TICK_MAX_REQUESTS; ) {
      if (countTrades(pages, before) >= wanted) break;
      const ranges: [number, number][] = [];
      for (let i = 0; i < TICK_CONCURRENCY && requests + i < TICK_MAX_REQUESTS && next >= 0; i++) {
        const from = Math.max(0, next - source.maxPerRequest + 1);
        ranges.push([from, next]);
        next = from - 1;
      }
      if (ranges.length === 0) {
        reachedStart = true;
        break;
      }
      const results = await mapLimit(ranges, TICK_CONCURRENCY, ([from, to]) =>
        source.aggTrades(ticker, from, to - from + 1),
      );
      requests += ranges.length;
      for (const [i, page] of results.entries()) {
        const [from, to] = ranges[i] as [number, number];
        const inRange = page.filter((trade) => trade.id >= from && trade.id <= to);
        pages.push(inRange);
        // The exchange had nothing older than this page.
        if (from === 0 || inRange.length < to - from + 1) reachedStart = true;
      }
      if (reachedStart) break;
    }

    const trades = dedupe(pages);
    let bars = foldTicks(trades, ticks, before);
    const first = trades[0];
    if (!reachedStart && first && bars[0] && first.firstId > bars[0].time * ticks) {
      bars = bars.slice(1); // its earliest trades are older than what was fetched
    }
    let hasMore = !reachedStart;
    if (bars.length > countBack) {
      bars = bars.slice(-countBack);
      hasMore = true;
    }
    const oldest = bars[0];
    if (hasMore && oldest) this.remember(symbol, oldest.time * ticks, trades);
    // History that reaches trade 0, the first a pair's trades can be numbered, is its listing's.
    return { bars, hasMore, fromListing: !hasMore && first?.firstId === 0 };
  }

  /** Notes which aggregate holds the trade just before trade `boundary`. */
  private remember(symbol: string, boundary: number, trades: readonly AggTrade[]): void {
    const holder = trades.find(
      (trade) => trade.firstId <= boundary - 1 && boundary - 1 <= trade.lastId,
    );
    if (!holder) return;
    let anchors = this.anchors.get(symbol);
    if (!anchors) {
      anchors = new Map();
      this.anchors.set(symbol, anchors);
    }
    anchors.set(boundary, holder.id);
    if (anchors.size > MAX_ANCHORS) {
      const oldest = anchors.keys().next().value;
      if (oldest !== undefined) anchors.delete(oldest);
    }
  }
}

function countTrades(pages: readonly AggTrade[][], before: number): number {
  let count = 0;
  for (const page of pages) {
    for (const trade of page) {
      count += Math.max(0, Math.min(trade.lastId, before - 1) - trade.firstId + 1);
    }
  }
  return count;
}

/** All aggregates once, ascending by id. */
function dedupe(pages: readonly AggTrade[][]): AggTrade[] {
  const byId = new Map<number, AggTrade>();
  for (const page of pages) for (const trade of page) byId.set(trade.id, trade);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * The live tick bar: seeded from the latest aggregates over REST, then extended by every
 * aggregate the stream sends. Aggregates the stream delivered before the seed are kept and
 * applied after it, and a gap in the trade ids (trades the stream never delivered) is
 * reported so the feed can start over.
 */
export class TickBars {
  private readonly ticks: number;
  private bars: Bar[] = [];
  private lastAggregate = -1;
  private lastTrade = -1;
  private seeded = false;
  private early: AggTrade[] = [];

  constructor(ticks: number) {
    this.ticks = ticks;
  }

  current(): Bar | null {
    const bar = this.bars.at(-1);
    return bar ? { ...bar } : null;
  }

  reset(): void {
    this.bars = [];
    this.lastAggregate = -1;
    this.lastTrade = -1;
    this.seeded = false;
    this.early = [];
  }

  /**
   * `latest`: the most recent aggregates, ascending. Returns the live bar, or 'gap' if the
   * aggregates the stream sent meanwhile don't follow on from them.
   */
  seed(latest: readonly AggTrade[]): BarChange[] | 'gap' {
    this.seeded = true;
    const newest = latest.at(-1);
    if (newest) {
      this.bars = foldTicks(latest, this.ticks).slice(-1);
      this.lastAggregate = newest.id;
      this.lastTrade = newest.lastId;
    }
    const early = this.early;
    this.early = [];
    for (const trade of early) {
      if (this.apply(trade) === 'gap') return 'gap';
    }
    const bar = this.current();
    return bar ? [{ bar, historical: false }] : [];
  }

  /** Applies a live aggregate: the bars it touched, or 'gap' when trades went missing. */
  apply(trade: Trade | AggTrade): BarChange[] | 'gap' {
    const aggregate = asAggregate(trade);
    if (!aggregate) return [];
    if (!this.seeded) {
      if (this.early.length < 10_000) this.early.push(aggregate);
      return [];
    }
    if (aggregate.id <= this.lastAggregate) return []; // already counted
    if (this.lastTrade >= 0 && aggregate.firstId !== this.lastTrade + 1) return 'gap';
    this.lastAggregate = aggregate.id;
    this.lastTrade = aggregate.lastId;
    const touched = addTicks(this.bars, aggregate, this.ticks);
    if (this.bars.length > 2) this.bars.splice(0, this.bars.length - 2);
    return touched.map((bar) => ({ bar: { ...bar }, historical: false }));
  }
}

function asAggregate(trade: Trade | AggTrade): AggTrade | null {
  const { id, firstId, lastId } = trade;
  if (id === undefined || firstId === undefined || lastId === undefined) return null;
  return { id, firstId, lastId, price: trade.price, quantity: trade.quantity, time: trade.time };
}
