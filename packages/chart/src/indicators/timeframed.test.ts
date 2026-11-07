import type { Bar } from '@tradingnerd/core';
import { defaultSettings, IndicatorRun, RSI } from '@tradingnerd/indicators';
import {
  type ContextData,
  DEFAULT_SYMBOL,
  type RequestFeed,
  type ScriptSymbol,
} from '@tradingnerd/pine';
import { describe, expect, it } from 'vitest';
import { builtinTimeframe, TimeframedRun } from './timeframed';

const DAY = 86_400;
/** Monday 1 January 2024, UTC: a crypto week opens on Monday, as TradingView's do. */
const MONDAY = Date.UTC(2024, 0, 1) / 1000;
/** 60 whole weeks of days, then 3 days of the 61st, still forming. */
const WEEKS = 60;
const DAYS = WEEKS * 7 + 3;

const days: Bar[] = Array.from({ length: DAYS }, (_, i) => {
  const close = 100 + 10 * Math.sin(i / 9) + i / 50;
  return {
    time: MONDAY + i * DAY,
    open: close - Math.cos(i),
    high: close + 2,
    low: close - 2,
    close,
    volume: 10,
  };
});

/** The days' weeks, as an exchange builds them: each Monday to Sunday, the last still forming. */
function weeksOf(list: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let start = 0; start < list.length; start += 7) {
    const week = list.slice(start, start + 7);
    out.push({
      time: (week[0] as Bar).time,
      open: (week[0] as Bar).open,
      high: Math.max(...week.map((bar) => bar.high)),
      low: Math.min(...week.map((bar) => bar.low)),
      close: (week.at(-1) as Bar).close,
      volume: week.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return out;
}

const CHART: ScriptSymbol = {
  ...DEFAULT_SYMBOL,
  ticker: 'XRPUSDT',
  tickerid: 'BINANCE:XRPUSDT',
  basecurrency: 'XRP',
  currency: 'USDT',
};
const WEEKLY: ScriptSymbol = { ...CHART, timeframe: '1W' };
const SYMBOL = { base: 'XRP', hasVolume: true };
const INPUTS = defaultSettings(RSI).inputs;
const KEY = { symbol: 'BINANCE:XRPUSDT', timeframe: '1W' };

/** A feed holding one context, swapped as the app's loader swaps it. */
function feedOf(initial: ContextData | 'invalid' | null) {
  let current = initial;
  const feed: RequestFeed = { data: () => current };
  return {
    feed,
    set(next: ContextData | 'invalid' | null) {
      current = next;
    },
  };
}

const context = (bars: readonly Bar[], version = 1, history = 1): ContextData => ({
  symbol: WEEKLY,
  bars,
  live: true,
  fromListing: false,
  version,
  history,
});

/** RSI's own values on the weeks, computed straight. */
function weeklyRsi(weeks: readonly Bar[]): number[] {
  const run = new IndicatorRun(RSI, INPUTS, SYMBOL);
  run.setBars(weeks);
  return run.values[0] as number[];
}

const timeframed = (feed: RequestFeed, gaps: boolean) =>
  new TimeframedRun(new IndicatorRun(RSI, INPUTS, SYMBOL), KEY, gaps, CHART, feed, SYMBOL);

describe("A built-in on another timeframe (RSI's Timeframe input, docs/SPEC.md §11 item 71)", () => {
  const weeks = weeksOf(days);
  const rsi = weeklyRsi(weeks);

  it('waits for its timeframe’s closes: each week’s value on the day the week closes', () => {
    const run = timeframed(feedOf(context(weeks)).feed, true);
    run.setBars(days);
    expect(run.waiting).toBe(false);
    expect(run.length).toBe(DAYS);
    const expected = days.map((_, d) =>
      d < WEEKS * 7 && d % 7 === 6 ? (rsi[(d - 6) / 7] as number) : Number.NaN,
    );
    expect(run.values[0]).toEqual(expected);
    // Week 14 is RSI's first trusted value (14 bars of warm-up): the chart shows it on its Sunday.
    expect(run.chartStart(14)).toBe(14 * 7 + 6);
  });

  it('unticked, fills the days with the latest closed week, and the forming day shows the forming week', () => {
    const run = timeframed(feedOf(context(weeks)).feed, false);
    run.setBars(days);
    const expected = days.map((_, d) => {
      if (d === DAYS - 1) return rsi[WEEKS] as number;
      const week = Math.floor((d + 1) / 7) - 1;
      return week >= 0 ? (rsi[week] as number) : Number.NaN;
    });
    expect(run.values[0]).toEqual(expected);
    expect(run.chartStart(14)).toBe(14 * 7 + 6);
  });

  it('draws nothing while its timeframe loads, says so, and draws once the bars come', () => {
    const { feed, set } = feedOf(null);
    const run = timeframed(feed, false);
    run.setBars(days);
    expect(run.waiting).toBe(true);
    expect(run.missing).toEqual([KEY]);
    expect(run.requested).toEqual([KEY]);
    expect(run.values[0]?.every(Number.isNaN)).toBe(true);
    expect(run.chartStart(0)).toBe(Number.POSITIVE_INFINITY);
    set(context(weeks));
    expect(run.update(days, 'tick', DAYS - 1)).toBe('all');
    expect(run.waiting).toBe(false);
    expect(run.missing).toEqual([]);
    expect(run.values[0]?.at(-1)).toBe(rsi[WEEKS]);
  });

  it('calls a timeframe the symbol doesn’t have invalid', () => {
    const run = timeframed(feedOf('invalid').feed, true);
    run.setBars(days);
    expect(run.invalid).toBe(true);
    expect(run.waiting).toBe(false);
    expect(run.values[0]?.every(Number.isNaN)).toBe(true);
  });

  it('follows the forming week live, and starts afresh on a new page of history', () => {
    const { feed, set } = feedOf(context(weeks));
    const run = timeframed(feed, false);
    run.setBars(days);
    // A tick of today's day: the forming week's close moves with it.
    const ticked = days.slice();
    ticked[DAYS - 1] = { ...(days[DAYS - 1] as Bar), close: 140, high: 142 };
    const tickedWeeks = weeksOf(ticked);
    set(context(tickedWeeks, 2, 1));
    run.update(ticked, 'tick', DAYS - 1);
    const live = weeklyRsi(tickedWeeks);
    expect(run.values[0]?.at(-1)).toBeCloseTo(live[WEEKS] as number, 12);
    expect(run.values[0]?.at(-2)).toBe(rsi[WEEKS - 1]);
    // A page of older weeks: everything again, from the first week of the new history.
    const older = weeksOf(ticked.slice(7));
    set(context(older, 3, 2));
    run.update(ticked.slice(7), 'tick', DAYS - 8);
    expect(run.length).toBe(DAYS - 7);
    expect(run.values[0]?.[20 * 7 + 6]).toBe(weeklyRsi(older)[20]);
  });
});

describe('builtinTimeframe: the timeframe a built-in runs on', () => {
  it('is none for the chart’s own timeframe, in any of its spellings', () => {
    expect(builtinTimeframe({ timeframe: '' }, CHART)).toBeNull();
    expect(builtinTimeframe({}, CHART)).toBeNull();
    expect(builtinTimeframe({ timeframe: '1D' }, CHART)).toBeNull();
    expect(builtinTimeframe({ timeframe: 'D' }, CHART)).toBeNull();
  });

  it('asks for the chart’s symbol on that timeframe, waiting for its closes unless unticked', () => {
    expect(builtinTimeframe({ timeframe: '1W', waitForClose: true }, CHART)).toEqual({
      key: { symbol: 'BINANCE:XRPUSDT', timeframe: '1W' },
      gaps: true,
    });
    expect(builtinTimeframe({ timeframe: '240', waitForClose: false }, CHART)).toEqual({
      key: { symbol: 'BINANCE:XRPUSDT', timeframe: '240' },
      gaps: false,
    });
    // A stock's chart with its extended hours asks for them too.
    const stock = { ...CHART, tickerid: 'NASDAQ:AAPL', session: 'extended' as const };
    expect(builtinTimeframe({ timeframe: '1W' }, stock)?.key).toEqual({
      symbol: 'NASDAQ:AAPL',
      timeframe: '1W',
      session: 'extended',
    });
  });
});
