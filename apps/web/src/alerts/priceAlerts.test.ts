import type { Bar, ErrorCode, SessionHours } from '@tradingnerd/core';
import { compileScript } from '@tradingnerd/pine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BarHandlers } from '../data/GatewayConnection';
import { AlertRunner, PRICE_RESOLUTION } from './AlertRunner';
import { alertPlace } from './AlertsPanel';
import {
  type AlertDef,
  alertTitle,
  conditionLabel,
  EVERY_TIME_GAP_MS,
  type PriceCondition,
  type PriceMove,
  type PriceOperator,
  PriceTrigger,
  PriceWatch,
  priceConditionMet,
} from './alertModel';
import { ALERTS_KEY, AlertStore, type NewAlert } from './alertStore';

/**
 * Price alerts (Help Center: How to use price alerts, Learn how to configure alerts, Differences
 * between alert frequencies): Crossing, Crossing Up, Crossing Down, Greater Than and Less Than a
 * value on a symbol's live price, triggering Only once or Every time.
 */

const move = (from: number, low: number, high: number, close: number): PriceMove => ({
  from,
  low,
  high,
  close,
});
const met = (operator: PriceOperator, m: PriceMove, value = 100) =>
  priceConditionMet({ operator, value }, m);

describe('price alert conditions', () => {
  it('Crossing Up: the price was below the value, then reached it', () => {
    expect(met('crossing_up', move(99, 99, 100, 100))).toBe(true);
    expect(met('crossing_up', move(99, 99.5, 101, 99.5))).toBe(true); // up through it and back
    expect(met('crossing_up', move(99, 101, 102, 101))).toBe(true); // a gap over it counts
    expect(met('crossing_up', move(98, 98, 99.9, 99.9))).toBe(false);
    // From above: only once it has been below and come back, which the close shows.
    expect(met('crossing_up', move(101, 101, 102, 102))).toBe(false);
    expect(met('crossing_up', move(101, 99, 101, 100))).toBe(true);
    expect(met('crossing_up', move(101, 99, 101, 99.5))).toBe(false);
    // Starting at the value isn't below it.
    expect(met('crossing_up', move(100, 100, 101, 101))).toBe(false);
  });

  it('Crossing Down: the price was above the value, then reached it', () => {
    expect(met('crossing_down', move(101, 100, 101, 100))).toBe(true);
    expect(met('crossing_down', move(101, 98, 101, 98))).toBe(true);
    expect(met('crossing_down', move(102, 100.1, 102, 100.1))).toBe(false);
    expect(met('crossing_down', move(99, 99, 101, 100))).toBe(true); // above it and back
    expect(met('crossing_down', move(99, 98, 99, 98))).toBe(false);
  });

  it('Crossing: either way', () => {
    expect(met('crossing', move(99, 99, 101, 101))).toBe(true);
    expect(met('crossing', move(101, 99, 101, 99))).toBe(true);
    expect(met('crossing', move(99, 98, 99.9, 98))).toBe(false);
    expect(met('crossing', move(100, 100, 101, 101))).toBe(false);
  });

  it('Greater Than and Less Than: beyond the value, not at it', () => {
    // "You set a Less than alert at $100,000. The notification will trigger when the BTC price
    // falls to $99,999.99."
    expect(met('less_than', move(105_000, 99_999.99, 105_000, 99_999.99), 100_000)).toBe(true);
    expect(met('less_than', move(105_000, 100_000, 105_000, 100_000), 100_000)).toBe(false);
    expect(met('greater_than', move(99, 99, 100.01, 99.5))).toBe(true);
    expect(met('greater_than', move(99, 99, 100, 100))).toBe(false);
    // Crossing Up takes reaching the value; Greater Than takes passing it.
    expect(met('crossing_up', move(99, 99, 100, 100))).toBe(true);
  });

  it('the first price crosses nothing, and meets Greater Than or Less Than if beyond the value', () => {
    const first = (close: number) => move(Number.NaN, close, close, close);
    for (const op of ['crossing', 'crossing_up', 'crossing_down'] as const) {
      expect(met(op, first(100))).toBe(false);
      expect(met(op, first(105))).toBe(false);
    }
    expect(met('greater_than', first(105))).toBe(true);
    expect(met('greater_than', first(100))).toBe(false);
    expect(met('less_than', first(95))).toBe(true);
  });
});

const bar = (time: number, low: number, high: number, close: number, open = close): Bar => ({
  time,
  open,
  high,
  low,
  close,
  volume: 1,
});

describe('price moves from a live bar stream (PriceWatch)', () => {
  it('starts at the first close, then takes each update’s new low or high and its close', () => {
    const watch = new PriceWatch();
    // The minute's earlier range came before the alert: only its close counts.
    expect(watch.move(bar(60, 95, 105, 99))).toEqual(move(Number.NaN, 99, 99, 99));
    // No new extreme: only the close is known.
    expect(watch.move(bar(60, 95, 105, 101))).toEqual(move(99, 101, 101, 101));
    // A new high traded since the update before.
    expect(watch.move(bar(60, 95, 107, 103))).toEqual(move(101, 103, 107, 103));
    expect(watch.move(bar(60, 94, 107, 96))).toEqual(move(103, 94, 96, 96));
    // A new minute: everything it traded is new.
    expect(watch.move(bar(120, 95, 97, 96.5, 95.5))).toEqual(move(96, 95, 97, 96.5));
    // A bar before the latest isn't the live price.
    expect(watch.move(bar(60, 90, 110, 100))).toBeNull();
  });

  it('sees a spike through the value inside one update, from the bar’s new high', () => {
    const trigger = new PriceTrigger(
      { kind: 'price', operator: 'crossing_up', value: 100, precision: 2 },
      'once',
    );
    expect(trigger.update(bar(60, 99, 99.5, 99.4), 0)).toBe(false);
    // Up to 100.2 and back to 99.6 between two updates: the bar's high shows it.
    expect(trigger.update(bar(60, 99, 100.2, 99.6), 1_000)).toBe(true);
  });
});

const condition = (operator: PriceOperator, value = 100): PriceCondition => ({
  kind: 'price',
  operator,
  value,
  precision: 2,
});

describe('when a price alert triggers (PriceTrigger)', () => {
  it('Every time: each time its condition is met, at most once a minute', () => {
    const trigger = new PriceTrigger(condition('crossing'), 'every');
    expect(trigger.update(bar(0, 99, 99, 99), 0)).toBe(false);
    expect(trigger.update(bar(0, 99, 101, 101), 1_000)).toBe(true);
    // Back down through it within the minute: not again yet.
    expect(trigger.update(bar(0, 98, 101, 98), 30_000)).toBe(false);
    expect(trigger.update(bar(60, 98, 102, 102), 1_000 + EVERY_TIME_GAP_MS)).toBe(true);
  });

  it('Every time on Greater Than: again each minute while the price stays above', () => {
    const trigger = new PriceTrigger(condition('greater_than'), 'every');
    expect(trigger.update(bar(0, 101, 101, 101), 0)).toBe(true);
    expect(trigger.update(bar(0, 101, 101, 101.5), 10_000)).toBe(false);
    expect(trigger.update(bar(60, 101, 102, 102), EVERY_TIME_GAP_MS)).toBe(true);
    expect(trigger.update(bar(120, 99, 99, 99), 2 * EVERY_TIME_GAP_MS + 1)).toBe(false);
  });
});

let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const priceAlert = (overrides: Partial<NewAlert> = {}): NewAlert => ({
  name: '',
  symbol: 'BINANCE:BTCUSDT',
  interval: '1D',
  script: null,
  condition: condition('crossing_up', 100_000),
  trigger: 'once',
  message: '',
  popup: true,
  sound: false,
  ...overrides,
});

describe('price alerts in the store and the manager', () => {
  it('are named by their condition, listed without a timeframe, and kept across a reload', () => {
    const store = new AlertStore();
    const made = store.create(priceAlert({ session: 'extended' }));
    expect(alertTitle(made)).toBe('BTCUSDT Crossing Up 100000.00');
    expect(conditionLabel(made.condition)).toBe('Crossing Up 100000.00');
    expect(new AlertStore().get().alerts).toEqual([made]);
    // A damaged one is left out.
    stored.set(
      ALERTS_KEY,
      JSON.stringify([
        { ...made, condition: { kind: 'price', operator: 'nearly', value: 1 } },
        { ...made, id: 'b', condition: { kind: 'price', operator: 'less_than', value: 'x' } },
      ]),
    );
    expect(new AlertStore().get().alerts).toEqual([]);
    const entry = store.fire(made, 'BTCUSDT Crossing Up 100000.00', 5);
    expect(alertPlace(entry.symbol, entry.interval)).toBe('BTCUSDT');
  });

  it('stop after triggering when Only once, and stay active when Every time', () => {
    const store = new AlertStore(false);
    const once = store.create(priceAlert());
    const every = store.create(priceAlert({ trigger: 'every' }));
    store.fire(once, 'hit', 1);
    store.fire(every, 'hit', 2);
    expect(store.get().alerts.map((a) => a.status)).toEqual(['triggered', 'active']);
  });
});

/** The gateway's live bars, by hand: each subscription and its handlers. */
function fakeLive() {
  const subs: {
    symbol: string;
    resolution: string;
    session: SessionHours | undefined;
    handlers: BarHandlers;
    open: boolean;
  }[] = [];
  return {
    subs,
    live: {
      subscribeBars(
        symbol: string,
        resolution: string,
        handlers: BarHandlers,
        session?: SessionHours,
      ) {
        const sub = { symbol, resolution, session, handlers, open: true };
        subs.push(sub);
        return () => {
          sub.open = false;
        };
      },
    },
    /** A bar on every open stream of the symbol's 1-minute bars. */
    send(b: Bar, historical = false) {
      for (const sub of subs) if (sub.open) sub.handlers.onBar(b, historical);
    },
    fail(code: ErrorCode, message: string) {
      const sub = subs.findLast((s) => s.open);
      if (!sub) return;
      sub.open = false;
      sub.handlers.onError(code, message);
    },
  };
}

function priceRunner() {
  const feed = fakeLive();
  const fired: { alert: string; message: string }[] = [];
  const errors: (string | null)[] = [];
  let now = Date.UTC(2026, 10, 9, 12);
  const runner = new AlertRunner({
    makeFeed: () => ({ data: () => null, want: () => {}, dispose: () => {} }),
    compile: (source) => compileScript(source),
    onFire: (alert, message) => fired.push({ alert: alert.id, message }),
    onError: (_alert, message) => errors.push(message),
    live: feed.live,
    now: () => now,
  });
  return {
    feed,
    runner,
    fired,
    errors,
    later(ms: number) {
      now += ms;
    },
  };
}

const def = (overrides: Partial<AlertDef> = {}): AlertDef => ({
  ...priceAlert(),
  condition: condition('crossing_up', 100),
  id: 'p1',
  status: 'active',
  created: 0,
  ...overrides,
});

describe('the alert runner, on a price alert’s live price', () => {
  it('watches the symbol’s 1-minute bars and triggers an Only once alert a single time', () => {
    const { feed, runner, fired } = priceRunner();
    runner.setAlerts([def({ session: 'extended' })]);
    expect(feed.subs.map((s) => [s.symbol, s.resolution, s.session])).toEqual([
      ['BINANCE:BTCUSDT', PRICE_RESOLUTION, 'extended'],
    ]);
    expect(runner.isRunning('p1')).toBe(true);
    feed.send(bar(60, 99, 99.5, 99.2));
    expect(fired).toEqual([]);
    // A correction to an earlier bar isn't the live price.
    feed.send(bar(0, 90, 120, 110), true);
    expect(fired).toEqual([]);
    feed.send(bar(60, 99, 100.4, 100.1));
    expect(fired).toEqual([{ alert: 'p1', message: 'BTCUSDT Crossing Up 100.00' }]);
    feed.send(bar(120, 98, 98, 98));
    feed.send(bar(120, 98, 101, 101));
    expect(fired).toHaveLength(1);
    expect(runner.isRunning('p1')).toBe(false);
  });

  it('fills in its message’s placeholders, and triggers Every time again a minute on', () => {
    const { feed, runner, fired, later } = priceRunner();
    runner.setAlerts([
      def({
        condition: condition('crossing', 100),
        trigger: 'every',
        message: '{{exchange}}:{{ticker}} crossed 100 at {{close}}',
      }),
    ]);
    feed.send(bar(60, 99, 99, 99));
    feed.send(bar(60, 99, 100.5, 100.5));
    later(30_000);
    feed.send(bar(60, 99.5, 100.5, 99.5));
    later(EVERY_TIME_GAP_MS);
    feed.send(bar(120, 99.5, 100.25, 100.25));
    expect(fired.map((f) => f.message)).toEqual([
      'BINANCE:BTCUSDT crossed 100 at 100.5',
      'BINANCE:BTCUSDT crossed 100 at 100.25',
    ]);
  });

  it('falls back to its own timeframe where there are no 1-minute bars, and says why it can’t run', () => {
    const { feed, runner, errors } = priceRunner();
    runner.setAlerts([def({ symbol: 'CRYPTOCAP:TOTAL', interval: '1D' })]);
    feed.fail('unsupported_resolution', 'CRYPTOCAP is served in fixed intervals');
    expect(feed.subs.map((s) => [s.resolution, s.open])).toEqual([
      ['1', false],
      ['1D', true],
    ]);
    expect(errors.filter((e) => e !== null)).toEqual([]);
    feed.fail('unknown_symbol', 'Unknown symbol');
    expect(errors.at(-1)).toBe('Unknown symbol');
    expect(runner.isRunning('p1')).toBe(false);
  });

  it('clears an earlier error when restarted', () => {
    const { feed, runner, errors } = priceRunner();
    const alert = def({ symbol: 'NASDAQ:AAPL' });
    runner.setAlerts([alert]);
    feed.fail('needs_key', 'US stock data needs your Alpaca key');
    expect(errors.at(-1)).toBe('US stock data needs your Alpaca key');
    runner.setAlerts([{ ...alert, status: 'stopped' }]);
    runner.setAlerts([{ ...alert }]);
    expect(errors.at(-1)).toBeNull();
    feed.send(bar(60, 99, 99, 99));
    expect(runner.isRunning('p1')).toBe(true);
  });

  it('stops watching an alert stopped, edited or removed', () => {
    const { feed, runner } = priceRunner();
    const alert = def();
    runner.setAlerts([alert]);
    // The same alert again keeps its stream.
    runner.setAlerts([alert]);
    expect(feed.subs.filter((s) => s.open)).toHaveLength(1);
    const edited = { ...alert, condition: condition('crossing_down', 90) };
    runner.setAlerts([edited]);
    expect(feed.subs.map((s) => s.open)).toEqual([false, true]);
    runner.setAlerts([{ ...edited, status: 'stopped' }]);
    expect(feed.subs.map((s) => s.open)).toEqual([false, false]);
    runner.setAlerts([def({ id: 'p2' })]);
    runner.dispose();
    expect(feed.subs.every((s) => !s.open)).toBe(true);
  });
});
