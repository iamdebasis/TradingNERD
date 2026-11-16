import type { ScriptRunner } from '@tradingnerd/chart';
import type { Bar } from '@tradingnerd/core';
import {
  type CompileResult,
  type ContextData,
  compileScript,
  DEFAULT_SYMBOL,
  type FromWorker,
  RemoteRun,
  type RequestKey,
  ScriptHost,
  type ToWorker,
} from '@tradingnerd/pine';
import { afterEach, describe, expect, it } from 'vitest';
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
  const symbol = { ...DEFAULT_SYMBOL, tickerid: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT' };
  let data: ContextData = {
    symbol: { ...symbol, timeframe: '1D' },
    bars,
    live: true,
    fromListing: true,
    version: 1,
    history: 1,
  };
  // Other symbols' bars, which scripts request, once they have loaded.
  const others = new Map<string, ContextData>();
  let callbacks: { onHistory(): void; onLive(): void } = { onHistory() {}, onLive() {} };
  const wanted: RequestKey[][] = [];
  const feed: AlertFeed = {
    data: (key) =>
      key.symbol === 'BINANCE:BTCUSDT' && key.timeframe === '1D'
        ? data
        : (others.get(`${key.symbol}@${key.timeframe}`) ?? null),
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
    /** Another symbol's daily bars have loaded, as a request asked. */
    provide(tickerid: string, list: Bar[]) {
      const ticker = tickerid.slice(tickerid.indexOf(':') + 1);
      others.set(`${tickerid}@1D`, {
        symbol: { ...symbol, tickerid, ticker, timeframe: '1D' },
        bars: list,
        live: true,
        fromListing: true,
        version: 1,
        history: 1,
      });
      callbacks.onHistory();
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

/**
 * Each alert's run in a worker of its own, the two ends over Node's MessageChannel, which copies
 * messages with V8's serializer as Chrome's workers do (docs/SPEC.md §6.22).
 */
function channelRunner() {
  const runs: RemoteRun[] = [];
  const stopped: RemoteRun[] = [];
  const runner: ScriptRunner = {
    run: (options) => {
      const { port1, port2 } = new MessageChannel();
      const host = new ScriptHost((message, transfer) => port2.postMessage(message, transfer));
      port2.onmessage = (event) => host.receive(event.data as ToWorker);
      const run = new RemoteRun(
        {
          post: (message, transfer) => port1.postMessage(message, transfer),
          close: () => {
            stopped.push(run);
            port1.close();
            port2.close();
          },
        },
        options,
      );
      port1.onmessage = (event) => run.receive(event.data as FromWorker);
      runs.push(run);
      return run;
    },
  };
  /** Until every running worker has answered all it was sent. */
  const answered = async () => {
    const busy = () => runs.some((run) => run.pending && !stopped.includes(run));
    for (let i = 0; i < 5000 && busy(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (busy()) throw new Error('A worker never answered');
  };
  return { runner, runs, stopped, answered };
}

const runners: AlertRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.dispose();
});

function runner(feed: ReturnType<typeof fakeFeed>, scripts?: ScriptRunner) {
  const fired: { alert: string; message: string }[] = [];
  const errors: (string | null)[] = [];
  const r = new AlertRunner({
    makeFeed: (callbacks) => feed.make(callbacks),
    compile: (source): CompileResult => compileScript(source),
    onFire: (alert, message) => fired.push({ alert: alert.id, message }),
    onError: (_alert, message) => errors.push(message),
    now: () => Date.UTC(2026, 0, 9, 12),
    ...(scripts ? { runner: scripts } : {}),
  });
  runners.push(r);
  return { r, fired, errors };
}

const def = (overrides: Partial<AlertDef>): AlertDef => ({
  ...alertOf(),
  id: 'a1',
  status: 'active',
  created: 0,
  ...overrides,
});

/**
 * Where an alert's copy of its script runs: in the page, or in a worker of its own (the app's
 * way since step 2b). Each case below runs both ways and must trigger the same alerts with the
 * same messages; in a worker, live ticks go out back to back before any is answered.
 */
const WHERE = [
  ['in the page', () => null],
  ['in a worker of its own', () => channelRunner()],
] as const;

describe.each(WHERE)('the alert runner, on its symbol’s live bars, %s', (_where, workers) => {
  /** The runner, and a wait for its workers' answers (none in the page: it's done at once). */
  function start(feed: ReturnType<typeof fakeFeed>) {
    const made = workers();
    return { ...runner(feed, made?.runner), answered: made?.answered ?? (async () => {}) };
  }

  it('triggers on alert() calls of realtime updates only, by their freq', async () => {
    const feed = fakeFeed(daily([100, 101, 102, 103]));
    const { r, fired, answered } = start(feed);
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
    await answered();
    expect(fired).toEqual([]);
    feed.tick(106);
    feed.tick(107);
    await answered();
    // Once per bar: the first call only.
    expect(fired.map((f) => f.message)).toEqual(['Above at 106']);
    feed.open(104);
    await answered();
    // The bar closed at 107: its closing run makes the bar-close call.
    expect(fired.map((f) => f.message)).toEqual(['Above at 106', 'Closed at 107']);
  });

  it('triggers an alertcondition() alert with its message’s placeholders filled in', async () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { r, fired, answered } = start(feed);
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
    await answered();
    expect(fired).toEqual([]);
    // In a worker the bar is at 112 before 111's run is answered: its message reads 111.
    feed.tick(111);
    feed.tick(112);
    await answered();
    expect(fired.map((f) => f.message)).toEqual(['BTCUSDT up: diff 9, close 111']);
  });

  it('triggers on a strategy’s order fills with the default message', async () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { r, fired, answered } = start(feed);
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
    await answered();
    expect(fired.map((f) => f.message)).toEqual([
      'buy @ 2 filled on BTCUSDT. New strategy position is 2',
    ]);
  });

  it('says why an alert can’t run, and stops what’s no longer active', async () => {
    const feed = fakeFeed(daily([100, 101]));
    const { r, errors, answered } = start(feed);
    r.setAlerts([def({ script: script('plot(nope)') })]);
    expect(errors[0]).toMatch(/nope/);
    expect(r.isRunning('a1')).toBe(false);
    const working = def({ id: 'a2' });
    r.setAlerts([working]);
    await answered();
    expect(r.isRunning('a2')).toBe(true);
    r.setAlerts([{ ...working, status: 'stopped' }]);
    expect(r.isRunning('a2')).toBe(false);
  });

  it('runs a script that waits for another symbol afresh once its bars come, history and all', async () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { r, fired, answered } = start(feed);
    r.setAlerts([
      def({
        script: script(`e = request.security("BINANCE:ETHUSDT", "1D", close)
if close > 105 and not na(e[1])
    alert("ETH the day before " + str.tostring(e[1]))`),
      }),
    ]);
    // ETH's bars come while its first run is still on its way (at once, before any answer, as
    // another alert's request may bring them): e[1] on the live bar is history, so it runs afresh.
    feed.provide('BINANCE:ETHUSDT', daily([30, 31, 32]));
    await answered();
    expect(feed.wanted.at(-1)).toContainEqual({ symbol: 'BINANCE:ETHUSDT', timeframe: '1D' });
    feed.tick(106);
    await answered();
    expect(fired.map((f) => f.message)).toEqual(['ETH the day before 31']);
  });
});

describe('the alert runner’s workers (docs/SPEC.md §6.22)', () => {
  it('gives each alert a worker of its own, stopped when the alert stops, is edited or reset', async () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { runner: scripts, runs, stopped, answered } = channelRunner();
    const { r } = runner(feed, scripts);
    const one = def({ id: 'a1' });
    const two = def({ id: 'a2' });
    r.setAlerts([one, two]);
    await answered();
    expect(runs).toHaveLength(2);
    expect(stopped).toEqual([]);
    // Edited: its copy starts afresh in a new worker, the old one stopped.
    const edited = { ...one, message: 'edited' };
    r.setAlerts([edited, two]);
    expect(runs).toHaveLength(3);
    expect(stopped).toEqual([runs[0]]);
    r.setAlerts([edited, { ...two, status: 'stopped' }]);
    expect(stopped).toEqual([runs[0], runs[1]]);
    // The libraries changed: every script compiles again, each in a new worker.
    r.reset([edited]);
    expect(stopped).toEqual([runs[0], runs[1], runs[2]]);
    expect(runs).toHaveLength(4);
    r.dispose();
    expect(stopped).toEqual(runs);
  });

  it('stops an "Only once" alert’s worker as soon as it triggers', async () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { runner: scripts, runs, stopped, answered } = channelRunner();
    const { r, fired } = runner(feed, scripts);
    r.setAlerts([
      def({
        script: script('alertcondition(close > 110, "Up", "Up at {{close}}")'),
        condition: { kind: 'condition', index: 0, title: 'Up' },
        trigger: 'once',
        message: 'Up at {{close}}',
      }),
    ]);
    feed.tick(111);
    await answered();
    expect(fired.map((f) => f.message)).toEqual(['Up at 111']);
    expect(stopped).toEqual(runs);
    feed.tick(115);
    await answered();
    expect(fired).toHaveLength(1);
  });

  it('stops an alert whose worker broke down, saying why', async () => {
    const feed = fakeFeed(daily([100, 101, 102]));
    const { runner: scripts, runs, answered } = channelRunner();
    const { r, errors } = runner(feed, scripts);
    r.setAlerts([def({})]);
    await answered();
    expect(errors.at(-1)).toBeNull();
    runs[0]?.crashed('The script’s worker stopped');
    expect(errors.at(-1)).toBe('The script’s worker stopped');
  });
});
