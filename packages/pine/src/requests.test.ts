import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  type ContextData,
  compileScript,
  DEFAULT_SYMBOL,
  type RequestFeed,
  ScriptRun,
  type ScriptSymbol,
} from './index.ts';

/**
 * request.security() as TradingView's Pine docs describe it (Other timeframes and data;
 * Repainting; the v6 reference): one hourly chart over three days, its days, another symbol's
 * hours with two missing, and quarter hours.
 */

const HOUR = 3600;
const DAY = 86_400;
/** Monday 5 January 2026, 00:00 UTC. */
const T0 = Date.UTC(2026, 0, 5) / 1000;

const bar = (time: number, close: number, volume = 10): Bar => ({
  time,
  open: close - 0.5,
  high: close + 1,
  low: close - 1,
  close,
  volume,
});

/** The chart: 72 hourly bars, closes 100 to 171; the last is live. */
const HOURS = Array.from({ length: 72 }, (_, i) => bar(T0 + i * HOUR, 100 + i));

/** Bars of `span` seconds made from the hours, as an exchange's would be. */
function aggregate(hours: readonly Bar[], span: number): Bar[] {
  const out: Bar[] = [];
  for (const h of hours) {
    const time = Math.floor((h.time - T0) / span) * span + T0;
    const last = out.at(-1);
    if (last && last.time === time) {
      last.high = Math.max(last.high, h.high);
      last.low = Math.min(last.low, h.low);
      last.close = h.close;
      last.volume += h.volume;
    } else out.push({ ...h, time });
  }
  return out;
}

/** The chart's days: closes 123, 147 and 171 (the last day is still going). */
const DAYS = aggregate(HOURS, DAY);

/** Quarter hours: each hour's four, the last one closing at the hour's close. */
const QUARTERS = HOURS.flatMap((h) =>
  [0.75, 0.5, 0.25, 0].map((k, q) => bar(h.time + q * 900, h.close - k)),
);

/** Another symbol's hours, closes 1000 + 2i, without the bars at 10:00 and 11:00. */
const OTHER = HOURS.map((h, i) => bar(h.time, 1000 + 2 * i)).filter((_, i) => i !== 10 && i !== 11);

const CHART: ScriptSymbol = {
  ...DEFAULT_SYMBOL,
  ticker: 'BTCUSDT',
  tickerid: 'BINANCE:BTCUSDT',
  basecurrency: 'BTC',
  currency: 'USDT',
  timeframe: '60',
};
const ETH: ScriptSymbol = {
  ...DEFAULT_SYMBOL,
  ticker: 'ETHUSD',
  tickerid: 'COINBASE:ETHUSD',
  basecurrency: 'ETH',
  currency: 'USD',
  timeframe: '60',
};

function context(
  symbol: ScriptSymbol,
  bars: readonly Bar[],
  timeframe: string,
  options: Partial<ContextData> = {},
): ContextData {
  return {
    symbol: { ...symbol, timeframe },
    bars,
    live: true,
    fromListing: true,
    version: 1,
    history: 1,
    ...options,
  };
}

/** The contexts the tests know, by "SYMBOL@timeframe"; unknown symbols are invalid. */
function feedOf(entries: Record<string, ContextData | null>): RequestFeed {
  return {
    data: (key) => {
      const text = `${key.symbol}@${key.timeframe}`;
      if (text in entries) return entries[text] ?? null;
      return key.symbol.startsWith('NOPE') ? 'invalid' : null;
    },
  };
}

const FEED = feedOf({
  'BINANCE:BTCUSDT@60': context(CHART, HOURS, '60'),
  'BINANCE:BTCUSDT@1D': context(CHART, DAYS, '1D'),
  'BINANCE:BTCUSDT@15': context(CHART, QUARTERS, '15'),
  'COINBASE:ETHUSD@60': context(ETH, OTHER, '60'),
});

function run(code: string, feed: RequestFeed = FEED, bars: readonly Bar[] = HOURS): ScriptRun {
  const result = compileScript(code);
  if (!result.ok) throw new Error(result.errors[0]?.message);
  const r = new ScriptRun(result.program, result.program.defaults(), CHART, feed);
  r.setBars(bars, true);
  return r;
}

const plotOf = (r: ScriptRun, p: number) =>
  Array.from(r.values[p] as Float64Array).slice(0, r.length);

const v6 = (lines: string) => `//@version=6\nindicator("Requests")\n${lines}`;

describe('request.security(): higher timeframes (Pine docs, Other timeframes and data)', () => {
  it("gives each period's value at its end on history, and the forming one live", () => {
    const r = run(v6('plot(request.security(syminfo.tickerid, "D", close))'));
    expect(r.error).toBeNull();
    const values = plotOf(r, 0);
    // "a new historical value at the end of each HTF period": the 23:00 bar closes with the day.
    expect(values.slice(0, 23).every(Number.isNaN)).toBe(true);
    expect(values[23]).toBe(123);
    expect(values[46]).toBe(123);
    expect(values[47]).toBe(147);
    expect(values[70]).toBe(147);
    // The realtime bar: the day still forming ("recalculated values on each chart bar").
    expect(values[71]).toBe(171);
  });

  it('with close[1] and lookahead_on, gives the last confirmed value from each start, live too', () => {
    const r = run(
      v6(
        'plot(request.security(syminfo.tickerid, "D", close[1], lookahead = barmerge.lookahead_on))',
      ),
    );
    const values = plotOf(r, 0);
    expect(values.slice(0, 24).every(Number.isNaN)).toBe(true);
    expect(values.slice(24, 48)).toEqual(Array(24).fill(123));
    // The realtime bar shows what history does: it doesn't repaint (Pine docs, Repainting).
    expect(values.slice(48, 72)).toEqual(Array(24).fill(147));
  });

  it("with lookahead_on and no offset, shows each day's close from its start: the future leak", () => {
    const r = run(
      v6('plot(request.security(syminfo.tickerid, "D", close, lookahead = barmerge.lookahead_on))'),
    );
    const values = plotOf(r, 0);
    expect(values[0]).toBe(123);
    expect(values[23]).toBe(123);
    expect(values[24]).toBe(147);
    // On the forming day there is no future to leak: its latest close.
    expect(values[48]).toBe(171);
  });

  it('with gaps_on, gives a value only where it first becomes available', () => {
    const r = run(
      v6('plot(request.security(syminfo.tickerid, "D", close, gaps = barmerge.gaps_on))'),
    );
    const values = plotOf(r, 0);
    const shown = values.flatMap((v, i) => (Number.isNaN(v) ? [] : [[i, v]]));
    // The forming day hasn't closed: nothing yet on the realtime bar.
    expect(shown).toEqual([
      [23, 123],
      [47, 147],
    ]);
  });
});

describe('request.security(): other symbols and lower timeframes', () => {
  it('lines another symbol up by time; a bar it lacks takes the latest value, or na with gaps_on', () => {
    const r = run(
      v6(`plot(request.security("COINBASE:ETHUSD", timeframe.period, close))
plot(request.security("COINBASE:ETHUSD", timeframe.period, close, gaps = barmerge.gaps_on))`),
    );
    const off = plotOf(r, 0);
    const on = plotOf(r, 1);
    expect(off[9]).toBe(1018);
    expect(off[10]).toBe(1018);
    expect(off[11]).toBe(1018);
    expect(off[12]).toBe(1024);
    expect(on[9]).toBe(1018);
    expect(on[10]).toBeNaN();
    expect(on[11]).toBeNaN();
    expect(on[12]).toBe(1024);
  });

  it('gives one intrabar a chart bar on a lower timeframe: the first with lookahead, else the last', () => {
    const r = run(
      v6(`plot(request.security(syminfo.tickerid, "15", close, lookahead = barmerge.lookahead_on))
plot(request.security(syminfo.tickerid, "15", close))`),
    );
    const first = plotOf(r, 0);
    const last = plotOf(r, 1);
    // Measured by others on TradingView: the hour's first and last 5-minute closes.
    expect(first[5]).toBe(105 - 0.75);
    expect(last[5]).toBe(105);
    // The realtime bar: the latest intrabar "regardless of the lookahead value".
    expect(first[71]).toBe(171);
  });

  it("reads the requested symbol's syminfo inside the request, and the chart's main_tickerid", () => {
    const r = run(
      v6(`plot(request.security("COINBASE:ETHUSD", "60", syminfo.ticker == "ETHUSD" ? 1 : 0))
plot(request.security("COINBASE:ETHUSD", "60", syminfo.main_tickerid == "BINANCE:BTCUSDT" ? 1 : 0))
plot(request.security("COINBASE:ETHUSD", "60", timeframe.main_period == "60" ? 1 : 0))`),
    );
    expect(plotOf(r, 0)[5]).toBe(1);
    expect(plotOf(r, 1)[5]).toBe(1);
    expect(plotOf(r, 2)[5]).toBe(1);
  });
});

describe('request.security(): what the request evaluates (Pine docs, Requestable data)', () => {
  it("copies only the code before the call: the manual's counter stays 0", () => {
    const r = run(
      v6(`var int counter = 0
requestedCounter = request.security(syminfo.tickerid, "", counter)
counter += 1
plot(counter)
plot(requestedCounter)`),
    );
    expect(plotOf(r, 0)[5]).toBe(6);
    expect(plotOf(r, 1).every((v) => v === 0)).toBe(true);
  });

  it("runs a variable's code on the other symbol's bars (the manual's price return)", () => {
    const r = run(
      v6(`priceReturn = (close - close[1]) / close[1]
requestedReturn = request.security("COINBASE:ETHUSD", timeframe.period, priceReturn)
plot(requestedReturn)`),
    );
    const values = plotOf(r, 0);
    // ETH's own return, not BTC's: 1004 after 1002.
    expect(values[2]).toBeCloseTo((1004 - 1002) / 1002, 12);
    // At 12:00, ETH's previous bar is 09:00's.
    expect(values[12]).toBeCloseTo((1024 - 1018) / 1018, 12);
  });

  it('gives a tuple back as a tuple', () => {
    const r = run(
      v6(`[o, c] = request.security(syminfo.tickerid, "D", [open, close])
plot(o)
plot(c)`),
    );
    expect(plotOf(r, 0)[23]).toBe(99.5);
    expect(plotOf(r, 1)[23]).toBe(123);
  });

  it("runs a function's code in the context, and a request in a function takes its arguments", () => {
    const r = run(
      v6(`f(len) => ta.sma(close, len)
g(len) => request.security(syminfo.tickerid, "D", ta.sma(close, len))
plot(request.security(syminfo.tickerid, "D", f(2)))
plot(g(2))
plot(g(3))`),
    );
    // The days' 2-day average once the second day closes: (123 + 147) / 2.
    expect(plotOf(r, 0)[47]).toBe(135);
    expect(plotOf(r, 1)[47]).toBe(135);
    // Each call is its own request: g(3) has no 3-day average before the third day.
    expect(plotOf(r, 2)[47]).toBeNaN();
    expect(plotOf(r, 2)[71]).toBe((123 + 147 + 171) / 3);
  });

  it('gives collections back as copies the script can change', () => {
    const r = run(
      v6(`a = request.security(syminfo.tickerid, "D", array.from(close))
if not na(a)
    array.push(a, 1)
plot(na(a) ? -1 : array.size(a))`),
    );
    const sizes = plotOf(r, 0);
    expect(sizes[23]).toBe(2);
    expect(sizes[30]).toBe(2);
  });

  it("gives enum members that are the script's own", () => {
    const r = run(
      v6(`enum Side
    up
    down
s = request.security(syminfo.tickerid, "D", close > open ? Side.up : Side.down)
plot(s == Side.up ? 1 : 0)`),
    );
    expect(plotOf(r, 0)[23]).toBe(1);
  });

  it("silences the copied code's logs: they're the script's own run's only", () => {
    const r = run(
      v6(`var float level = na
if barstate.isfirst
    level := high
    log.info("first")
plot(request.security(syminfo.tickerid, "D", level))`),
    );
    expect(r.logs.map((log) => log.message)).toEqual(['first']);
    // The copied code runs on the days: barstate.isfirst is the first day, its high 124.
    expect(plotOf(r, 0)[23]).toBe(124);
  });

  it('keeps only the latest bars with calc_bars_count', () => {
    const r = run(
      v6(`plot(request.security(syminfo.tickerid, "D", bar_index))
plot(request.security(syminfo.tickerid, "D", bar_index, calc_bars_count = 1))`),
    );
    expect(plotOf(r, 0)[47]).toBe(1);
    expect(plotOf(r, 1)[47]).toBe(0);
  });

  it('looks ahead by default in v1 and v2 (the v6 reference)', () => {
    const r = run('//@version=2\nstudy("Old")\nplot(security(tickerid, "D", close))');
    expect(r.error).toBeNull();
    expect(plotOf(r, 0)[0]).toBe(123);
  });
});

describe('request.security(): loading, limits and errors', () => {
  it('draws nothing while a context loads, and runs once it has', () => {
    const entries: Record<string, ContextData | null> = { 'BINANCE:BTCUSDT@1D': null };
    const code = v6('plot(request.security(syminfo.tickerid, "D", close))');
    const result = compileScript(code);
    if (!result.ok) throw new Error(result.errors[0]?.message);
    const r = new ScriptRun(result.program, result.program.defaults(), CHART, feedOf(entries));
    r.setBars(HOURS, true);
    expect(r.waiting).toBe(true);
    expect(r.missing).toEqual([{ symbol: 'BINANCE:BTCUSDT', timeframe: '1D' }]);
    expect(r.plotStarts).toEqual([Number.POSITIVE_INFINITY]);
    entries['BINANCE:BTCUSDT@1D'] = context(CHART, DAYS, '1D');
    r.setBars(HOURS, true);
    expect(r.waiting).toBe(false);
    expect(r.plotStarts).toEqual([0]);
    expect(plotOf(r, 0)[23]).toBe(123);
  });

  it("stops on a symbol that doesn't exist, or gives na with ignore_invalid_symbol", () => {
    const stops = run(v6('plot(request.security("NOPE:NOPE", "D", close))'));
    expect(stops.error?.message).toBe('Invalid symbol "NOPE:NOPE"');
    const ignores = run(
      v6('plot(request.security("NOPE:NOPE", "D", close, ignore_invalid_symbol = true))'),
    );
    expect(ignores.error).toBeNull();
    expect(plotOf(ignores, 0).every(Number.isNaN)).toBe(true);
  });

  it('stops past 40 unique requests; identical ones count once (Pine docs, Limitations)', () => {
    const distinct = Array.from(
      { length: 41 },
      (_, i) => `plot(request.security("SYM:S${i}", "D", close))`,
    ).join('\n');
    expect(run(v6(distinct)).error?.message).toBe(
      'Script requests too many securities: 41. The limit is 40',
    );
    const same = Array.from(
      { length: 50 },
      (_, i) => `x${i} = request.security(syminfo.tickerid, "D", close)`,
    ).join('\n');
    const r = run(v6(`${same}\nplot(x49)`));
    expect(r.error).toBeNull();
    expect(plotOf(r, 0)[23]).toBe(123);
  });

  it('refuses more than 127 tuple elements in all', () => {
    const items = Array.from({ length: 128 }, () => 'close').join(', ');
    const names = Array.from({ length: 128 }, (_, i) => `v${i}`).join(', ');
    const result = compileScript(
      v6(`[${names}] = request.security(syminfo.tickerid, "D", [${items}])\nplot(v0)`),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain('127');
  });

  it("stops with the context's own runtime error", () => {
    const r = run(
      v6('plot(request.security(syminfo.tickerid, "D", array.get(array.new<float>(0), 0)))'),
    );
    expect(r.error?.message).toMatch(/out of (the array's )?bounds|index/i);
  });

  it("doesn't draw values from a context's bars that still depend on its bars not loaded", () => {
    // 40 days of hours; the days' history isn't from the listing, so an average's start is checked.
    const hours = Array.from({ length: 40 * 24 }, (_, i) => bar(T0 + i * HOUR, 100 + (i % 7)));
    const days = aggregate(hours, DAY);
    const feed = feedOf({
      'BINANCE:BTCUSDT@1D': context(CHART, days, '1D', { fromListing: false }),
    });
    const listed = feedOf({ 'BINANCE:BTCUSDT@1D': context(CHART, days, '1D') });
    const code = v6(`plot(request.security(syminfo.tickerid, "D", ta.ema(close, 3)))
plot(request.security(syminfo.tickerid, "D", close))`);
    const checked = run(code, feed, hours);
    // Every output waits for the average to settle; a plain close needs nothing before it.
    expect(checked.plotStarts[0]).toBeGreaterThan(24);
    expect(checked.plotStarts[0]).toBeLessThan(hours.length);
    expect(checked.plotStarts[1]).toBe(checked.plotStarts[0]);
    // From the listing, nothing earlier exists: drawn from the start, as TradingView's.
    expect(run(code, listed, hours).plotStarts).toEqual([0, 0]);
  });

  it('follows the live bar: a tick of the chart reads the context as it is now', () => {
    let daily = context(CHART, DAYS, '1D');
    const feed: RequestFeed = {
      data: (key) =>
        key.timeframe === '1D'
          ? daily
          : key.timeframe === '60'
            ? context(CHART, HOURS, '60')
            : null,
    };
    const result = compileScript(v6('plot(request.security(syminfo.tickerid, "D", close))'));
    if (!result.ok) throw new Error(result.errors[0]?.message);
    const r = new ScriptRun(result.program, result.program.defaults(), CHART, feed);
    r.setBars(HOURS, true);
    expect(plotOf(r, 0)[71]).toBe(171);
    const hours = [...HOURS.slice(0, -1), bar(HOURS[71]?.time as number, 180)];
    const days = [...DAYS.slice(0, -1), { ...(DAYS[2] as Bar), close: 180 }];
    daily = { ...daily, bars: days, version: 2 };
    expect(r.update(hours, 'tick', 71)).toEqual([71]);
    expect(plotOf(r, 0)[71]).toBe(180);
  });
});
