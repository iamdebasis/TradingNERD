import { type Bar, type BarClock, type Resolution, UTC_CLOCK } from '@tradingnerd/core';
import type { CandleUpdate, Trade } from './types.ts';

export interface BarChange {
  bar: Bar;
  /** True for a late correction to a bar before the current one. */
  historical: boolean;
}

/** Guards memory if the candle stream stalls while trades keep coming. */
const MAX_PENDING_TRADES = 10_000;

/**
 * Merges an exchange's periodic candle snapshots with its real-time trades into one live bar.
 *
 * Binance pushes candle snapshots only every 2 s but trades as they happen. Snapshots are
 * authoritative up to their event time. Trades after that time make the close tick immediately
 * and open the next bar on the exact boundary, instead of up to 2 s late.
 */
export class LiveBarAggregator {
  private readonly resolution: Resolution;
  private readonly clock: BarClock;
  private bar: Bar | null = null;
  /** Trades newer than the latest snapshot, which doesn't include them yet. */
  private pending: Trade[] = [];

  constructor(resolution: Resolution, clock: BarClock = UTC_CLOCK) {
    this.resolution = resolution;
    this.clock = clock;
  }

  current(): Bar | null {
    return this.bar ? { ...this.bar } : null;
  }

  reset(): void {
    this.bar = null;
    this.pending = [];
  }

  /** Starts from a REST copy of the latest bar, unless the stream has already got further. */
  seed(bar: Bar): BarChange[] {
    if (this.bar && this.bar.time >= bar.time) return [];
    this.bar = { ...bar };
    this.pending = [];
    return [{ bar: { ...this.bar }, historical: false }];
  }

  applyCandle({ bar: candle, eventTime }: CandleUpdate): BarChange[] {
    if (this.bar && candle.time < this.bar.time) {
      // The final snapshot of a bar that trades already moved past.
      return [{ bar: { ...candle }, historical: true }];
    }
    const sameBar = this.bar !== null && candle.time === this.bar.time;
    const startMs = candle.time * 1000;
    const newer = this.pending.filter((trade) => trade.time > eventTime && trade.time >= startMs);

    this.bar =
      sameBar && this.bar
        ? {
            ...candle,
            high: Math.max(candle.high, this.bar.high),
            low: Math.min(candle.low, this.bar.low),
          }
        : { ...candle };
    for (const trade of newer) applyTrade(this.bar, trade);
    this.pending = newer;
    return [{ bar: { ...this.bar }, historical: false }];
  }

  applyTrade(trade: Trade): BarChange[] {
    if (!this.bar) return []; // nothing to build on until a snapshot arrives
    // Outside the bars' hours (a stock's post-market for regular-session bars) a trade belongs
    // to no bar, so it mustn't move the last one.
    if (!this.clock.isOpen(trade.time)) return [];
    const openMs = this.clock.open(this.resolution, trade.time);
    const currentMs = this.bar.time * 1000;
    if (openMs < currentMs) return []; // late trade for an earlier bar; its final snapshot fixes it

    if (openMs > currentMs) {
      // First trade of a new bar: open it now rather than at the next snapshot.
      this.bar = {
        time: openMs / 1000,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: 0,
      };
      this.pending = [];
    }
    applyTrade(this.bar, trade);
    this.pending.push(trade);
    if (this.pending.length > MAX_PENDING_TRADES) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_TRADES);
    }
    return [{ bar: { ...this.bar }, historical: false }];
  }
}

function applyTrade(bar: Bar, trade: Trade): void {
  bar.close = trade.price;
  bar.high = Math.max(bar.high, trade.price);
  bar.low = Math.min(bar.low, trade.price);
  bar.volume += trade.quantity;
}
