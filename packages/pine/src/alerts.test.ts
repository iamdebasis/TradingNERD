import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { fillPlaceholders, type PlaceholderContext, placeholderTime } from './alerts.ts';
import { compileScript, DEFAULT_SYMBOL, ScriptRun } from './index.ts';

/**
 * Alert events as TradingView's Pine docs describe them (Concepts, Alerts): alert() calls make
 * events only on realtime bars, with their frequency; alertcondition() lists its title and
 * message and keeps its condition; placeholders fill in when an alert triggers.
 */

const DAY = 86_400;
const T0 = 1_700_000_000;

const barsOf = (closes: readonly number[]): Bar[] =>
  closes.map((close, i) => ({
    time: T0 + i * DAY,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 10,
  }));

function watched(source: string, bars: Bar[]): ScriptRun {
  const result = compileScript(source);
  if (!result.ok) throw new Error(result.errors[0]?.message);
  const run = new ScriptRun(result.program, result.program.defaults(), DEFAULT_SYMBOL);
  run.watchAlerts();
  run.setBars(bars, true);
  return run;
}

describe('alert() events (Pine docs, Alerts: alert() function events)', () => {
  const source = `//@version=6
indicator("Alerts")
if close > 100
    alert("Above: " + str.tostring(close))
alert("Every bar", alert.freq_all)
alert("At the close", alert.freq_once_per_bar_close)`;

  it('makes events only on realtime bars, from the updates after the alert starts', () => {
    const bars = barsOf([90, 95, 101, 102]);
    const run = watched(source, bars);
    // History never alerts, and a run afresh doesn't either.
    expect(run.takeAlerts()).toEqual([]);
    const ticked = [...bars.slice(0, -1), { ...(bars[3] as Bar), close: 103 }];
    run.update(ticked, 'tick', 3);
    expect(run.takeAlerts()).toEqual([
      { call: 0, message: 'Above: 103', freq: 'once_per_bar', bar: 3, final: false },
      { call: 1, message: 'Every bar', freq: 'all', bar: 3, final: false },
      { call: 2, message: 'At the close', freq: 'once_per_bar_close', bar: 3, final: false },
    ]);
    // A new bar: the one before closes (its run is final), then the new one runs.
    const next = [...ticked, ...barsOf([99]).map((b) => ({ ...b, time: T0 + 4 * DAY }))];
    run.update(next, 'new', 4);
    const events = run.takeAlerts();
    expect(events.filter((e) => e.bar === 3).every((e) => e.final)).toBe(true);
    expect(events.filter((e) => e.bar === 4).map((e) => e.message)).toEqual([
      'Every bar',
      'At the close',
    ]);
    expect(run.takeAlerts()).toEqual([]);
  });

  it('does nothing while no alert runs the script, as on a chart', () => {
    const result = compileScript(source);
    if (!result.ok) throw new Error('no compile');
    const run = new ScriptRun(result.program, result.program.defaults(), DEFAULT_SYMBOL);
    const bars = barsOf([101, 102]);
    run.setBars(bars, true);
    run.update(bars, 'tick', 1);
    expect(run.takeAlerts()).toEqual([]);
  });

  it('in a strategy, uses once per bar close unless calc_on_every_tick', () => {
    const body = 'alert("Fill check", alert.freq_all)';
    const strategy = (extra: string) => `//@version=6\nstrategy("S"${extra})\n${body}`;
    const bars = barsOf([100, 101, 102]);
    const closes = watched(strategy(''), bars);
    const next = [...bars, ...barsOf([103]).map((b) => ({ ...b, time: T0 + 3 * DAY }))];
    closes.update(next, 'new', 3);
    // It ran only on bar 2's close: "once per bar close", whatever the call asks.
    expect(closes.takeAlerts()).toEqual([
      { call: 0, message: 'Fill check', freq: 'once_per_bar_close', bar: 2, final: true },
    ]);
    const ticks = watched(strategy(', calc_on_every_tick = true'), bars);
    ticks.update(bars, 'tick', 2);
    expect(ticks.takeAlerts().map((e) => e.freq)).toEqual(['all']);
  });
});

describe('alertcondition() (Pine docs, Alerts: alertcondition() events)', () => {
  it('lists its title and message, "Alert" when untitled, and keeps its condition', () => {
    const source = `//@version=6
indicator("Conditions")
r = close - open
plot(r, "R")
alertcondition(close > 100, "Long Alert", "Go long. R is {{plot_0}}")
alertcondition(close < 95)`;
    const result = compileScript(source);
    if (!result.ok) throw new Error('no compile');
    expect(result.program.alertConditions).toEqual([
      { title: 'Long Alert', message: 'Go long. R is {{plot_0}}' },
      { title: 'Alert', message: '' },
    ]);
    expect(result.program.hasAlertCalls).toBe(false);
    const run = watched(source, barsOf([90, 101, 94]));
    expect([0, 1, 2].map((bar) => run.conditionOn(0, bar))).toEqual([false, true, false]);
    expect([0, 1, 2].map((bar) => run.conditionOn(1, bar))).toEqual([true, false, true]);
  });

  it('refuses a message that isn’t a const string', () => {
    const result = compileScript(
      '//@version=6\nindicator("X")\nalertcondition(close > 1, "T", str.tostring(close))',
    );
    expect(result.ok).toBe(false);
  });
});

describe('placeholders (Pine docs, Alerts: Placeholders)', () => {
  const ctx: PlaceholderContext = {
    exchange: 'BINANCE',
    ticker: 'BTCUSDT',
    interval: '60',
    bar: { time: Date.UTC(2019, 7, 27, 9, 56), open: 1, high: 2.5, low: 0.5, close: 2, volume: 10 },
    now: Date.UTC(2019, 7, 27, 10, 0, 1, 700),
    plots: [
      { title: 'RSI', value: 53.41 },
      { title: 'Signal', value: 50 },
    ],
  };

  it('fills in the bar, the symbol, the plots and the times', () => {
    expect(
      fillPlaceholders(
        '{{exchange}}:{{ticker}} {{interval}} O{{open}} H{{high}} L{{low}} C{{close}} V{{volume}}',
        ctx,
      ),
    ).toBe('BINANCE:BTCUSDT 60 O1 H2.5 L0.5 C2 V10');
    expect(fillPlaceholders('RSI is {{plot_0}}, {{plot("Signal")}}', ctx)).toBe('RSI is 53.41, 50');
    // UTC, yyyy-MM-ddTHH:mm:ssZ; timenow to the second.
    expect(fillPlaceholders('{{time}} {{timenow}}', ctx)).toBe(
      '2019-08-27T09:56:00Z 2019-08-27T10:00:01Z',
    );
    expect(placeholderTime(Date.UTC(2019, 7, 27, 9, 56))).toBe('2019-08-27T09:56:00Z');
  });

  it('leaves unknown ones as written, and a strategy’s only with an order fill', () => {
    expect(fillPlaceholders('{{plot_25}} {{nope}} {{strategy.order.action}}', ctx)).toBe(
      '{{plot_25}} {{nope}} {{strategy.order.action}}',
    );
    const filled = fillPlaceholders(
      '{{strategy.order.action}} @ {{strategy.order.contracts}} filled on {{ticker}}. New strategy position is {{strategy.position_size}}',
      {
        ...ctx,
        order: {
          action: 'buy',
          contracts: 2,
          price: 101.5,
          id: 'Long',
          comment: '',
          alertMessage: 'go',
          positionSize: 2,
          marketPosition: 'long',
          prevMarketPosition: 'flat',
        },
      },
    );
    expect(filled).toBe('buy @ 2 filled on BTCUSDT. New strategy position is 2');
  });
});
