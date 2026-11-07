import type { Bar } from '@tradingnerd/core';
import type { BarChange, IndicatorRun } from '@tradingnerd/indicators';
import {
  alignBar,
  type ContextData,
  canonicalTimeframe,
  isLower,
  type RequestFeed,
  type RequestKey,
  type ScriptSymbol,
  timesOf,
} from '@tradingnerd/pine';

/**
 * A built-in computed on another timeframe, as its Timeframe input asks (docs/SPEC.md §11, item
 * 71): its own run over that timeframe's bars, from the request feed as a script's requests get
 * theirs, its values merged onto the chart's bars as Pine's `timeframe =` merges a script's
 * (TradingView's Help Center: "Wait for timeframe closes" shows a value once its bar closes;
 * unticked, the gaps take the latest value and the forming bar shows live).
 */
export class TimeframedRun {
  readonly symbol: unknown;
  readonly growing: readonly boolean[] = [];
  values: number[][] = [];
  /** Its timeframe's bars haven't loaded yet: it draws nothing meanwhile. */
  waiting = false;
  /** Its timeframe doesn't exist for the symbol. */
  invalid = false;
  readonly key: RequestKey;
  private readonly inner: IndicatorRun;
  private readonly gaps: boolean;
  private readonly chart: ScriptSymbol;
  private readonly feed: RequestFeed | undefined;
  private data: ContextData | null = null;
  /** For each chart bar, the timeframe's bar whose values it shows (-1 for none). */
  private map = new Int32Array(0);
  private chartLength = 0;

  constructor(
    inner: IndicatorRun,
    key: RequestKey,
    gaps: boolean,
    chart: ScriptSymbol,
    feed: RequestFeed | undefined,
    symbol: unknown,
  ) {
    this.inner = inner;
    this.key = key;
    this.gaps = gaps;
    this.chart = chart;
    this.feed = feed;
    this.symbol = symbol;
  }

  get length(): number {
    return this.chartLength;
  }

  get requested(): readonly RequestKey[] {
    return [this.key];
  }

  get missing(): readonly RequestKey[] {
    return this.waiting ? [this.key] : [];
  }

  /** Whether its timeframe's history starts at the symbol's listing (the warm-up rule's). */
  get fromListing(): boolean {
    return this.data?.fromListing ?? false;
  }

  /** The first chart bar showing a value from the timeframe's bar `start` or later. */
  chartStart(start: number): number {
    if (!Number.isFinite(start)) return start;
    for (let i = 0; i < this.map.length; i++) if ((this.map[i] as number) >= start) return i;
    return Number.POSITIVE_INFINITY;
  }

  setBars(bars: readonly Bar[]): void {
    this.chartLength = bars.length;
    const data = this.feed?.data(this.key) ?? null;
    if (data === null || data === 'invalid') {
      this.data = null;
      this.waiting = data === null;
      this.invalid = data === 'invalid';
      this.map = new Int32Array(bars.length).fill(-1);
      this.values = this.inner.definition.plots.map(() =>
        new Array<number>(bars.length).fill(Number.NaN),
      );
      return;
    }
    this.waiting = false;
    this.invalid = false;
    this.data = data;
    this.inner.setBars(data.bars);
    this.merge(bars);
  }

  update(bars: readonly Bar[], _change: BarChange, _index: number): number[] | 'all' {
    const data = this.feed?.data(this.key) ?? null;
    const before = this.data;
    if (
      !before ||
      data === null ||
      data === 'invalid' ||
      data.history !== before.history ||
      data.bars.length < this.inner.length
    ) {
      this.setBars(bars);
      return 'all';
    }
    if (data.version !== before.version) {
      const length = this.inner.length;
      if (data.bars.length === length) this.inner.update(data.bars, 'tick', length - 1);
      else {
        for (let n = length + 1; n <= data.bars.length; n++) {
          const upTo = n === data.bars.length ? data.bars : data.bars.slice(0, n);
          this.inner.update(upTo, 'new', n - 1);
        }
      }
      this.data = data;
    }
    this.chartLength = bars.length;
    this.merge(bars);
    return 'all';
  }

  private merge(bars: readonly Bar[]): void {
    const data = this.data as ContextData;
    const own = timesOf(data.bars, data.symbol, this.key.timeframe);
    const chart = timesOf(bars, this.chart, this.chart.timeframe);
    const lower = isLower(this.key.timeframe, this.chart.timeframe);
    const context = {
      opens: own.opens,
      closes: own.closes,
      count: data.bars.length,
      live: data.live,
    };
    const map = new Int32Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      map[i] = alignBar(
        {
          open: chart.opens[i] as number,
          close: chart.closes[i] as number,
          prevOpen: i > 0 ? (chart.opens[i - 1] as number) : Number.NaN,
          prevClose: i > 0 ? (chart.closes[i - 1] as number) : Number.NaN,
          realtime: i >= bars.length - 1,
        },
        context,
        lower,
        { gaps: this.gaps, lookahead: false },
      );
    }
    this.map = map;
    this.values = this.inner.values.map((plot) => {
      const out = new Array<number>(bars.length);
      for (let i = 0; i < bars.length; i++) {
        const j = map[i] as number;
        out[i] = j >= 0 ? (plot[j] ?? Number.NaN) : Number.NaN;
      }
      return out;
    });
  }
}

/**
 * The timeframe a built-in runs on, from its Timeframe input (none for the chart's own), and
 * whether it waits for that timeframe's closes.
 */
export function builtinTimeframe(
  inputs: Readonly<Record<string, unknown>>,
  chart: ScriptSymbol,
): { key: RequestKey; gaps: boolean } | null {
  const asked = typeof inputs.timeframe === 'string' ? inputs.timeframe : '';
  const timeframe = asked ? canonicalTimeframe(asked) : null;
  if (!timeframe || timeframe === canonicalTimeframe(chart.timeframe)) return null;
  const key: RequestKey = {
    symbol: chart.tickerid.toUpperCase(),
    timeframe,
    ...(chart.session === 'extended' ? { session: 'extended' as const } : {}),
  };
  return { key, gaps: inputs.waitForClose !== false };
}
