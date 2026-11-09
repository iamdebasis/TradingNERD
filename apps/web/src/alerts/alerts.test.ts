import type { Bar } from '@tradingnerd/core';
import {
  type CompileResult,
  type ContextData,
  compileScript,
  DEFAULT_SYMBOL,
  type RequestKey,
} from '@tradingnerd/pine';
import { describe, expect, it } from 'vitest';
import { type AlertFeed, AlertRunner } from './AlertRunner';
import { type AlertDef, TriggerState } from './alertModel';
import { AlertStore, type NewAlert } from './alertStore';

/**
 * Alerts on scripts (Pine docs, Concepts, Alerts; Help Center, Differences between alert
 * frequencies): when alert() calls, alertcondition() conditions and order fills trigger, the
 * store's log and pop-ups, and the runner on its own symbol's live bars.
 */

describe('when an alert triggers (TriggerState)', () => {
  it('takes alert() calls by their freq: all, each call’s first on a bar, or the close', () => {
    const state = new TriggerState();
    const call = (c: number, freq: 'all' | 'once_per_bar' | 'once_per_bar_close', final = false) =>
      ({ call: c, freq, final }) as const;
    expect(state.callFires(call(0, 'all'), 100)).toBe(true);
    expect(state.callFires(call(0, 'all'), 100)).toBe(true);
    // "only the first time each of the alert() calls is executed during the realtime bar".
    expect(state.callFires(call(1, 'once_per_bar'), 100)).toBe(true);
    expect(state.callFires(call(1, 'once_per_bar'), 100)).toBe(false);
    expect(state.callFires(call(2, 'once_per_bar'), 100)).toBe(true);
    expect(state.callFires(call(1, 'once_per_bar'), 200)).toBe(true);
    expect(state.callFires(call(3, 'once_per_bar_close'), 200)).toBe(false);
    expect(state.callFires(call(3, 'once_per_bar_close', true), 200)).toBe(true);
  });

  it('takes an alertcondition() by its trigger: once, once per bar, at the close, per minute', () => {
    const state = new TriggerState();
    expect(state.conditionFires('once', false, false, 1, 0)).toBe(false);
    expect(state.conditionFires('once', true, false, 1, 0)).toBe(true);
    expect(state.conditionFires('bar', true, false, 1, 0)).toBe(true);
    expect(state.conditionFires('bar', true, false, 1, 5)).toBe(false);
    expect(state.conditionFires('bar', true, true, 2, 9)).toBe(true);
    expect(state.conditionFires('close', true, false, 3, 0)).toBe(false);
    expect(state.conditionFires('close', true, true, 3, 0)).toBe(true);
    expect(state.conditionFires('minute', true, false, 4, 1_000)).toBe(true);
    expect(state.conditionFires('minute', true, false, 4, 59_000)).toBe(false);
    expect(state.conditionFires('minute', true, false, 5, 61_000)).toBe(true);
  });
});

const script = (body: string, declaration = 'indicator("Alerts test")') => ({
  title: 'Alerts test',
  source: `//@version=6\n${declaration}\n${body}`,
  inputs: {},
});

const alertOf = (overrides: Partial<NewAlert> = {}): NewAlert => ({
  name: '',
  symbol: 'BINANCE:BTCUSDT',
  interval: '1D',
  script: script('alert("hi")'),
  condition: { kind: 'calls' },
  trigger: 'bar',
  message: '',
  popup: true,
  sound: false,
  ...overrides,
});

describe('the alerts store', () => {
  it('logs what triggered, shows a pop-up, and stops an "Only once" alert', () => {
    const store = new AlertStore(false);
    const alert = store.create(
      alertOf({ condition: { kind: 'condition', index: 0, title: 'Long' }, trigger: 'once' }),
    );
    expect(store.get().alerts.map((a) => a.status)).toEqual(['active']);
    store.fire(alert, 'Go long', 1_000);
    const { log, toasts, alerts } = store.get();
    expect(log.map((e) => [e.name, e.message, e.time])).toEqual([
      ['Alerts test: Long', 'Go long', 1_000],
    ]);
    expect(toasts.map((t) => t.message)).toEqual(['Go long']);
    // "Stopped — Triggered".
    expect(alerts[0]?.status).toBe('triggered');
    store.restart(alert.id);
    expect(store.get().alerts[0]?.status).toBe('active');
    store.dismissToast(toasts[0]?.id ?? '');
    expect(store.get().toasts).toEqual([]);
  });
});

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 5) / 1000;

/** A feed of one symbol's daily bars, moved by hand; the runner's loader stand-in. */
function fakeFeed(bars: Bar[]) {
  // The bars, changed in place as the app's loader changes its own.
  const held = bars;
  let data: ContextData = {
    symbol: { ...DEFAULT_SYMBOL, tickerid: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT', timeframe: '1D' },
    bars,
    live: true,
    fromListing: true,
    version: 1,
    history: 1,
  };
  let callbacks: { onHistory(): void; onLive(): void } = { onHistory() {}, onLive() {} };
  const wanted: RequestKey[][] = [];
  const feed: AlertFeed = {
    data: (key) => (key.symbol === 'BINANCE:BTCUSDT' && key.timeframe === '1D' ? data : null),
    want: (_missing, used) => {
      wanted.push([...used]);
    },
    dispose: () => {},
  };
  return {
    make(next: { onHistory(): void; onLive(): void }) {
      callbacks = next;
      return feed;
    },
    /** The live bar moves to `close`. */
    tick(close: number) {
      const last = data.bars.at(-1) as Bar;
      held[held.length - 1] = { ...last, close, high: Math.max(last.high, close) };
      data = { ...data, version: data.version + 1 };
      callbacks.onLive();
    },
    /** A new bar opens at `close`: the last one closes. */
    open(close: number) {
      const last = data.bars.at(-1) as Bar;
      held.push({
        ...last,
        time: last.time + DAY,
        open: close,
        high: close,
        low: close,
        close,
      });
      data = { ...data, version: data.version + 1 };
      callbacks.onLive();
    },
    wanted,
  };
}

const daily = (closes: readonly number[]): Bar[] =>
  closes.map((close, i) => ({
    time: T0 + i * DAY,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 5,
  }));

function runner(feed: ReturnType<typeof fakeFeed>) {
  const fired: { alert: string; message: string }[] = [];
  const errors: (string | null)[] = [];
  const r = new AlertRunner({
    makeFeed: (callbacks) => feed.make(callbacks),
    compile: (source): CompileResult => compileScript(source),
    onFire: (alert, message) => fired.push({ alert: alert.id, message }),
    onError: (_alert, message) => errors.push(message),
    now: () => Date.UTC(2026, 0, 9, 12),
  });
  return { r, fired, errors };
}

const def = (overrides: Partial<AlertDef>): AlertDef => ({
  ...alertOf(),
  id: 'a1',
  status: 'active',
  created: 0,
  ...overrides,
});

describe('the alert runner, on its symbol’s live bars', () => {
  it('triggers on alert() calls of realtime updates only, by their freq', () => {
    const feed = fakeFeed(daily([100, 101, 102, 103]));
    const { r, fired } = runner(feed);
    r.setAlerts([
      def({
        script: script(`if close > 105
    alert("Above at " + str.tostring(close))
alert("Closed at " + str.tostring(close), alert.freq_once_per_bar_close)`),
      }),
    ]);
    // Its own symbol and timeframe are kept live; history doesn't alert.
    expect(feed.wanted.at(-1)).toContainEqual({ symbol: 'BINANCE:BTCUSDT', timeframe: '1D' });
    expect(r.isRunning('a1')).toBe(true);
    expect(fired).toEqual([]);
    feed.tick(106);
    feed.tick(107);
    // Once per bar: the first call only.
    expect(fired.map((f) => f.message)).toEqual(['Above at 106']);
    feed.open(104);
    // The bar closed at 107: its closing run makes the bar-close call.
    expect(fired.map((f) => f.message)).toEqual(['Above at 106', 'Closed at 107']);
  });

  it('triggers an alertcondition() alert with its message’s placeholders filled in', () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { r, fired } = runner(feed);
    const body = `d = close - open
plot(d, "Diff")
alertcondition(close > 110, "Up", "{{ticker}} up: diff {{plot_0}}, close {{close}}")`;
    r.setAlerts([
      def({
        script: script(body),
        condition: { kind: 'condition', index: 0, title: 'Up' },
        trigger: 'bar',
        message: '{{ticker}} up: diff {{plot_0}}, close {{close}}',
      }),
    ]);
    feed.tick(109);
    expect(fired).toEqual([]);
    feed.tick(111);
    feed.tick(112);
    expect(fired.map((f) => f.message)).toEqual(['BTCUSDT up: diff 9, close 111']);
  });

  it('triggers on a strategy’s order fills with the default message', () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { r, fired } = runner(feed);
    r.setAlerts([
      def({
        script: script(
          'if close > 105 and strategy.position_size == 0\n    strategy.entry("L", strategy.long, qty = 2)',
          'strategy("Fills test")',
        ),
        condition: { kind: 'fills' },
      }),
    ]);
    feed.tick(106);
    // A strategy runs on a realtime bar at its close: the order goes in, and fills on the next open.
    feed.open(107);
    expect(fired.map((f) => f.message)).toEqual([
      'buy @ 2 filled on BTCUSDT. New strategy position is 2',
    ]);
  });

  it('says why an alert can’t run, and stops what’s no longer active', () => {
    const feed = fakeFeed(daily([100, 101]));
    const { r, errors } = runner(feed);
    r.setAlerts([def({ script: script('plot(nope)') })]);
    expect(errors[0]).toMatch(/nope/);
    expect(r.isRunning('a1')).toBe(false);
    const working = def({ id: 'a2' });
    r.setAlerts([working]);
    expect(r.isRunning('a2')).toBe(true);
    r.setAlerts([{ ...working, status: 'stopped' }]);
    expect(r.isRunning('a2')).toBe(false);
  });
});
