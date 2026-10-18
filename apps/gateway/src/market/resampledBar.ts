import { type Bar, barOpenTime, type Resolution, resampleBars } from '@tradingnerd/core';
import { type BarChange, LiveBarAggregator } from './liveBar.ts';
import type { CandleUpdate, Trade } from './types.ts';

/** The live-bar logic a feed drives, for native and resampled intervals alike. */
export interface LiveBars {
  current(): Bar | null;
  reset(): void;
  /** Starts from REST copies of recent bars (ascending), unless the stream got further. */
  seed(bars: readonly Bar[]): BarChange[];
  applyCandle(update: CandleUpdate): BarChange[];
  applyTrade(trade: Trade): BarChange[];
}

/** An interval the exchange streams itself. */
export function nativeLiveBars(resolution: Resolution): LiveBars {
  const aggregator = new LiveBarAggregator(resolution);
  return {
    current: () => aggregator.current(),
    reset: () => aggregator.reset(),
    seed: (bars) => {
      const latest = bars.at(-1);
      return latest ? aggregator.seed(latest) : [];
    },
    applyCandle: (update) => aggregator.applyCandle(update),
    applyTrade: (trade) => aggregator.applyTrade(trade),
  };
}

interface Period {
  /** Open time of the target bar, ms. */
  open: number;
  /** Its base bars so far, by open time (s). */
  bars: Map<number, Bar>;
}

/**
 * A live bar for an interval the exchange doesn't stream (e.g. 45 seconds), built from a base
 * interval it does (1 second): the base bar is live-merged as usual, and the target bar is the
 * fold of every base bar in its period.
 *
 * Base bars of the current and the previous period are kept, so the exchange's late final word
 * on a base bar still corrects the right target bar. Nothing is emitted until the current
 * period's earlier base bars have been seeded over REST, so a half-built bar is never shown.
 */
export class ResampledBarAggregator implements LiveBars {
  private readonly target: Resolution;
  private readonly base: LiveBarAggregator;
  private period: Period | null = null;
  private previous: Period | null = null;
  private seeded = false;

  constructor(target: Resolution, base: Resolution) {
    this.target = target;
    this.base = new LiveBarAggregator(base);
  }

  current(): Bar | null {
    return this.seeded && this.period ? fold(this.period, this.target) : null;
  }

  reset(): void {
    this.base.reset();
    this.period = null;
    this.previous = null;
    this.seeded = false;
  }

  /** `bars`: the latest base bars from REST, covering at least the current period. */
  seed(bars: readonly Bar[]): BarChange[] {
    const latest = bars.at(-1);
    if (latest) {
      const open = this.openOf(latest);
      if (!this.period || open > this.period.open) {
        this.previous = this.period;
        this.period = { open, bars: new Map() };
      }
      if (open === this.period.open) {
        // REST fills in what the stream hasn't covered; the stream's copies are newer.
        for (const bar of bars) {
          if (this.openOf(bar) === open && !this.period.bars.has(bar.time)) {
            this.period.bars.set(bar.time, { ...bar });
          }
        }
        this.base.seed(latest);
        const live = this.base.current();
        if (live && this.openOf(live) === open) this.period.bars.set(live.time, live);
      }
    }
    this.seeded = true;
    const bar = this.current();
    return bar ? [{ bar, historical: false }] : [];
  }

  applyCandle(update: CandleUpdate): BarChange[] {
    return this.fold(this.base.applyCandle(update));
  }

  applyTrade(trade: Trade): BarChange[] {
    return this.fold(this.base.applyTrade(trade));
  }

  private fold(changes: BarChange[]): BarChange[] {
    const out: BarChange[] = [];
    for (const { bar, historical } of changes) {
      const open = this.openOf(bar);
      let changed: Period | null = null;
      if (!this.period || open > this.period.open) {
        if (historical) continue; // a correction never opens a period
        this.previous = this.period;
        this.period = { open, bars: new Map([[bar.time, bar]]) };
        changed = this.period;
      } else if (open === this.period.open) {
        this.period.bars.set(bar.time, bar);
        changed = this.period;
      } else if (historical && this.previous && open === this.previous.open) {
        this.previous.bars.set(bar.time, bar);
        changed = this.previous;
      }
      if (changed && this.seeded) {
        out.push({ bar: fold(changed, this.target), historical: changed !== this.period });
      }
    }
    return out;
  }

  private openOf(bar: Bar): number {
    return barOpenTime(this.target, bar.time * 1000);
  }
}

function fold(period: Period, target: Resolution): Bar {
  const bars = [...period.bars.values()].sort((a, b) => a.time - b.time);
  const [bar] = resampleBars(bars, target);
  if (!bar) throw new Error('A period always holds at least one bar');
  return bar;
}
