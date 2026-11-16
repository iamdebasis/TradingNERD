import type { Bar } from '@tradingnerd/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type FromWorker, RemoteRun, type ResultFor, ScriptHost, type ToWorker } from './remote.ts';
import type { ContextData, RequestFeed } from './requests.ts';
import { DEFAULT_SYMBOL, type LogEntry, type ScriptSymbol } from './runtime.ts';
import { compileScript, type ScriptProgram, ScriptRun } from './script.ts';
import { forming, indicator, program, walk, walkBar } from './testing.ts';

/**
 * A script in a worker of its own (docs/SPEC.md §6.23) gives the chart what the same script run
 * in the page gives, through loads, live changes, requests, drawings, strategies and Pine Logs,
 * and its copy of the results moves with the chart's bars. The two ends talk over Node's
 * MessageChannel, which copies messages with V8's serializer, as Chrome's workers do.
 */

interface NodePort {
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  close(): void;
}
declare const MessageChannel: new () => { port1: NodePort; port2: NodePort };
declare function setTimeout(callback: (...args: never[]) => void, ms: number): unknown;

const opened: RemoteRun[] = [];
afterEach(() => {
  for (const run of opened.splice(0)) run.dispose();
});

interface Options {
  inputs?: readonly unknown[];
  symbol?: ScriptSymbol;
  feed?: RequestFeed;
  libraries?: Record<string, string>;
  alerts?: boolean;
}

/** A script's run in a worker of its own, and what the worker was sent. */
function inWorker(p: ScriptProgram, options: Options = {}) {
  const { port1, port2 } = new MessageChannel();
  const received: ToWorker[] = [];
  const host = new ScriptHost((message, transfer) => port2.postMessage(message, transfer));
  port2.on('message', (message) => {
    received.push(message as ToWorker);
    host.receive(message as ToWorker);
  });
  const run = new RemoteRun(
    {
      post: (message, transfer) => port1.postMessage(message, transfer),
      close: () => {
        port1.close();
        port2.close();
      },
    },
    {
      program: p,
      inputs: options.inputs ?? [],
      symbol: options.symbol ?? DEFAULT_SYMBOL,
      ...(options.feed ? { feed: options.feed } : {}),
      ...(options.libraries ? { libraries: options.libraries } : {}),
      ...(options.alerts ? { alerts: true } : {}),
    },
  );
  const results: ('all' | readonly number[])[] = [];
  const ran: (ResultFor | undefined)[] = [];
  run.onResult = (changed, what) => {
    results.push(changed);
    ran.push(what);
  };
  port1.on('message', (message) => run.receive(message as FromWorker));
  opened.push(run);
  const loads = () => received.filter((message) => message.kind === 'load').length;
  return { run, received, results, ran, loads };
}

/** Until the worker has answered everything. */
async function settled(run: RemoteRun): Promise<void> {
  for (let i = 0; i < 5000 && run.pending; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (run.pending) throw new Error('The worker never answered');
}

const upTo = (arrays: readonly (Float64Array | null)[], length: number) =>
  arrays.map((array) => array && Array.from(array.subarray(0, length)));

/**
 * Drawings without their ids: each run numbers its own from one counter per page or worker, so
 * two runs in this one process number theirs apart (the chart never reads them).
 */
function withoutIds(drawings: RemoteRun['drawings']): unknown {
  const bare = (objects: readonly object[]) =>
    objects.map((object) => {
      const { id: _id, ...rest } = object as { id: number };
      return rest;
    });
  return {
    labels: bare(drawings.labels),
    lines: bare(drawings.lines),
    boxes: bare(drawings.boxes),
    tables: bare(drawings.tables),
    polylines: bare(drawings.polylines),
    linefills: drawings.linefills.map((fill) => ({
      color: fill.color,
      lines: bare([fill.line1, fill.line2]),
    })),
  };
}

/** The worker's results, as the chart has them, are the page's run's. */
function expectSame(remote: RemoteRun, local: ScriptRun): void {
  expect(remote.length).toBe(local.length);
  expect(upTo(remote.values, remote.length)).toEqual(upTo(local.values, local.length));
  expect(upTo(remote.plotColors, remote.length)).toEqual(upTo(local.plotColors, local.length));
  expect(upTo(remote.backgrounds, remote.length)).toEqual(upTo(local.backgrounds, local.length));
  expect(upTo(remote.fillColors, remote.length)).toEqual(upTo(local.fillColors, local.length));
  expect(remote.plotStarts).toEqual(local.plotStarts);
  expect(remote.backgroundStarts).toEqual(local.backgroundStarts);
  expect(remote.fillStarts).toEqual(local.fillStarts);
  expect(remote.offsets).toEqual(local.offsets);
  expect(remote.error).toEqual(local.error);
  expect(remote.missing).toEqual(local.missing);
  expect(remote.requested).toEqual(local.requested);
  expect(withoutIds(remote.drawings)).toEqual(withoutIds(local.drawings));
  expect(remote.strategy).toEqual(local.strategy);
  // A live bar's entries are stamped with when they ran (Pine docs, Debugging): the two runs ran
  // moments apart, so those times are only near each other.
  const untimed = (logs: readonly LogEntry[]) =>
    logs.map((entry) => (entry.realtime ? { ...entry, time: 0 } : entry));
  expect(untimed(remote.logs)).toEqual(untimed(local.logs));
  remote.logs.forEach((entry, i) => {
    if (entry.realtime)
      expect(Math.abs(entry.time - (local.logs[i]?.time ?? 0))).toBeLessThan(5_000);
  });
  expect(remote.logsWritten).toBe(local.logsWritten);
}

const SCRIPT = indicator(
  [
    'fast = ta.ema(close, 9)',
    'slow = ta.sma(close, 21)',
    'var int crosses = 0',
    'if ta.cross(fast, slow)',
    '    crosses += 1',
    'p1 = plot(fast, color = fast > slow ? color.green : color.red)',
    'p2 = plot(slow)',
    'plot(crosses, offset = 2)',
    'plot(close[3] - ta.highest(5))',
    'fill(p1, p2, color = fast > slow ? color.new(color.green, 80) : color.new(color.red, 80))',
    'bgcolor(ta.rsi(close, 14) > 60 ? color.new(color.blue, 90) : na)',
  ].join('\n'),
);

describe('A script in a worker', () => {
  it('gives what the page’s run gives: values, colors, fills, backgrounds, starts, offsets', async () => {
    const p = program(SCRIPT);
    const bars = walk(300);
    const local = new ScriptRun(p, []);
    local.setBars(bars, false, true);
    const { run, results } = inWorker(p);
    expect(run.ready).toBe(false);
    run.setBars(bars, false, true);
    await settled(run);
    expect(run.ready).toBe(true);
    expect(results).toEqual(['all']);
    expectSame(run, local);
    // The warm-up rule's starts came across: not every plot is drawn from bar 0.
    expect(run.plotStarts.some((start) => start > 0)).toBe(true);
  });

  it('follows ticks, new bars and corrections as the page’s run does', async () => {
    const p = program(SCRIPT);
    const bars = walk(200);
    const local = new ScriptRun(p, []);
    local.setBars(bars, false, true);
    const { run, results } = inWorker(p);
    run.setBars(bars, false, true);
    await settled(run);
    const step = async (change: 'tick' | 'new' | 'correction', index: number) => {
      local.update(bars, change, index);
      run.update(bars, change, index);
      await settled(run);
      expectSame(run, local);
    };
    for (let tick = 1; tick <= 3; tick++) {
      bars[199] = forming(walkBar(199), tick);
      await step('tick', 199);
    }
    bars[199] = walkBar(199);
    bars.push(forming(walkBar(200), 1));
    await step('new', 200);
    bars[199] = { ...walkBar(199), close: (bars[199] as Bar).close * 1.01 };
    await step('correction', 199);
    // Each result said which bars changed, as the page's run's update does.
    expect(results.slice(1)).toEqual([[199], [199], [199], [199, 200], [199, 200]]);
  });

  it('runs a script that imports a library with the library’s code sent along', async () => {
    const lib = '//@version=6\nlibrary("lib")\nexport double(float x) => x * 2';
    const code = '//@version=6\nindicator("X")\nimport someone/lib/1 as l\nplot(l.double(close))';
    const compiled = compileScript(code, { resolveLibrary: () => lib });
    if (!compiled.ok) throw new Error(compiled.errors[0]?.message);
    const bars = walk(20);
    const local = new ScriptRun(compiled.program, []);
    local.setBars(bars, true);
    const { run } = inWorker(compiled.program, { libraries: { 'someone/lib/1': lib } });
    run.setBars(bars, true);
    await settled(run);
    expectSame(run, local);
    // Without the library's code the worker can't compile it: the script stops, saying why.
    const missing = inWorker(compiled.program);
    missing.run.setBars(bars, true);
    await settled(missing.run);
    expect(missing.run.error?.message).toMatch(/lib/);
  });

  it('gives the same drawings, trades and Pine Logs, live entries added as they come', async () => {
    const p = program(
      [
        '//@version=6',
        'strategy("Test", overlay = true, calc_on_every_tick = true)',
        'if bar_index % 10 == 0',
        '    strategy.entry("L", strategy.long)',
        'if bar_index % 10 == 5',
        '    strategy.close("L")',
        'if barstate.islast',
        '    label.new(bar_index, high, str.tostring(close))',
        'log.info("bar {0}", bar_index)',
        'plot(close)',
      ].join('\n'),
    );
    const bars = walk(60);
    const local = new ScriptRun(p, []);
    local.setBars(bars, true);
    const { run } = inWorker(p);
    run.setBars(bars, true);
    await settled(run);
    expectSame(run, local);
    expect(run.strategy?.fills.length).toBeGreaterThan(0);
    expect(run.drawings.labels).toHaveLength(1);
    const logs = run.logs;
    for (let tick = 1; tick <= 2; tick++) {
      bars[59] = forming(walkBar(59), tick);
      local.update(bars, 'tick', 59);
      run.update(bars, 'tick', 59);
      await settled(run);
      expectSame(run, local);
    }
    // Live entries joined the same list, as a run's own do.
    expect(run.logs).toBe(logs);
    expect(run.logsWritten).toBe(62);
  });
});

/** A feed as the app's loader keeps one: live bars changed in place with a new version. */
class LoaderLike implements RequestFeed {
  readonly entries = new Map<string, ContextData>();

  data(key: { symbol: string; timeframe: string }): ContextData | null {
    return this.entries.get(`${key.symbol}@${key.timeframe}`) ?? null;
  }

  live(text: string, bar: Bar): void {
    const data = this.entries.get(text) as ContextData;
    const bars = data.bars as Bar[];
    if (bar.time > (bars.at(-1)?.time ?? 0)) bars.push(bar);
    else bars[bars.length - 1] = bar;
    this.entries.set(text, { ...data, version: data.version + 1 });
  }
}

const CHART: ScriptSymbol = {
  ...DEFAULT_SYMBOL,
  ticker: 'BTCUSDT',
  tickerid: 'BINANCE:BTCUSDT',
  timeframe: '1',
};

/** The chart's minutes made into 5-minute bars, as an exchange's would be. */
function fives(minutes: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const m of minutes) {
    const time = Math.floor(m.time / 300) * 300;
    const last = out.at(-1);
    if (last && last.time === time) {
      last.high = Math.max(last.high, m.high);
      last.low = Math.min(last.low, m.low);
      last.close = m.close;
      last.volume += m.volume;
    } else out.push({ ...m, time });
  }
  return out;
}

/** alert() calls of each frequency and two alertcondition()s, as an alert runs them. */
const ALERTING = indicator(
  [
    'up = close > open',
    'alertcondition(up, "Up", "An up bar")',
    'alertcondition(close > ta.sma(close, 5), "Above", "Above its mean")',
    'if up',
    '    alert("up " + str.tostring(close), alert.freq_all)',
    'if barstate.isconfirmed',
    '    alert("closed", alert.freq_once_per_bar_close)',
    'alert("any")',
    'plot(close)',
  ].join('\n'),
);

/** Every bar's alertcondition() conditions, by condition. */
const conditionsOf = (
  run: { conditionOn(index: number, bar: number): boolean | null },
  length: number,
) => [0, 1].map((index) => Array.from({ length }, (_, bar) => run.conditionOn(index, bar)));

describe('An alert’s run in a worker', () => {
  it('gives the alert() events and alertcondition() values the page’s run gives, live bar by live bar', async () => {
    const p = program(ALERTING);
    const bars = walk(50);
    bars[49] = forming(walkBar(49), 1);
    const local = new ScriptRun(p, []);
    local.watchAlerts();
    local.setBars(bars, false, true);
    const { run, ran } = inWorker(p, { alerts: true });
    run.setBars(bars, false, true);
    await settled(run);
    // A run afresh doesn't alert: its realtime bar's calls were the earlier run's.
    expect(local.takeAlerts()).toEqual([]);
    expect(run.takeAlerts()).toEqual([]);
    expect(conditionsOf(run, 50)).toEqual(conditionsOf(local, 50));
    expect(ran[0]).toEqual({ kind: 'load', length: 50, live: true });
    const step = async (change: 'tick' | 'new', index: number) => {
      local.update(bars, change, index);
      run.update(bars, change, index);
      await settled(run);
      const events = run.takeAlerts();
      expect(events).toEqual(local.takeAlerts());
      expect(conditionsOf(run, bars.length)).toEqual(conditionsOf(local, bars.length));
      return events;
    };
    for (let tick = 2; tick <= 4; tick++) {
      bars[49] = forming(walkBar(49), tick);
      expect((await step('tick', 49)).length).toBeGreaterThan(0);
    }
    bars[49] = walkBar(49);
    bars.push(forming(walkBar(50), 1));
    const closed = await step('new', 50);
    // The closing run of bar 49 made its once-per-close event; the new bar's first run its own.
    expect(closed.filter((event) => event.freq === 'once_per_bar_close').map((e) => e.bar)).toEqual(
      [49],
    );
    expect(closed.some((event) => event.bar === 50)).toBe(true);
    // Each live result said what it ran on: the change and the bars as they were sent.
    expect(ran.slice(1).map((what) => what?.kind === 'update' && what.change)).toEqual([
      'tick',
      'tick',
      'tick',
      'new',
    ]);
    const opened = ran[4] as Extract<ResultFor, { kind: 'update' }>;
    expect(opened.from).toBe(49);
    expect(opened.bars).toEqual([walkBar(49), forming(walkBar(50), 1)]);
  });

  it('tells each result the bars it ran on, though newer ticks came before it was answered', async () => {
    const p = program(ALERTING);
    const bars = walk(30);
    const { run, ran } = inWorker(p, { alerts: true });
    run.setBars(bars, false, true);
    await settled(run);
    // Three ticks sent at once: the bars move on before the first is answered.
    for (let tick = 1; tick <= 3; tick++) {
      bars[29] = forming(walkBar(29), tick);
      run.update(bars, 'tick', 29);
    }
    await settled(run);
    expect(
      ran.slice(1).map((what) => (what?.kind === 'update' ? what.bars[0]?.close : null)),
    ).toEqual([1, 2, 3].map((tick) => forming(walkBar(29), tick).close));
  });

  it('a chart’s run sends no conditions or events; an alert’s move with older bars', async () => {
    const p = program(ALERTING);
    const bars = walk(30);
    const chart = inWorker(p);
    chart.run.setBars(bars, false, true);
    await settled(chart.run);
    bars[29] = forming(walkBar(29), 1);
    chart.run.update(bars, 'tick', 29);
    await settled(chart.run);
    expect(chart.run.conditions).toEqual([]);
    expect(chart.run.conditionOn(0, 29)).toBeNull();
    expect(chart.run.takeAlerts()).toEqual([]);

    const alert = inWorker(p, { alerts: true });
    alert.run.setBars(bars, false, true);
    await settled(alert.run);
    bars[29] = forming(walkBar(29), 2);
    alert.run.update(bars, 'tick', 29);
    await settled(alert.run);
    const before = conditionsOf(alert.run, 30);
    alert.run.prepended(5);
    const events = alert.run.takeAlerts();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.bar === 34)).toBe(true);
    expect(conditionsOf(alert.run, 35).map((list) => list.slice(5))).toEqual(before);
  });
});

describe('A script’s requests in a worker', () => {
  const REQUEST = indicator(
    'plot(request.security(syminfo.tickerid, "5", ta.sma(close, 3)))\nplot(close)',
  );

  it('waits for a context, then runs with it, then follows its live bars', async () => {
    const minutes = walk(120);
    const feed = new LoaderLike();
    const p = program(REQUEST);
    const { run, received } = inWorker(p, { symbol: CHART, feed });
    run.setBars(minutes, false, true);
    await settled(run);
    // The first run asked for it: the chart loads it, then runs the script again.
    expect(run.waiting).toBe(true);
    expect(run.missing.map((key) => key.timeframe)).toEqual(['5']);
    feed.entries.set('BINANCE:BTCUSDT@5', {
      symbol: { ...CHART, timeframe: '5' },
      bars: fives(minutes),
      live: true,
      fromListing: false,
      version: 1,
      history: 1,
    });
    const local = new ScriptRun(p, [], CHART, feed);
    local.setBars(minutes, false, true);
    run.setBars(minutes, false, true);
    await settled(run);
    expect(run.waiting).toBe(false);
    expectSame(run, local);
    // A live minute moves the context's live bar too: only its last bars go to the worker.
    const next = forming(walkBar(119), 2);
    minutes[119] = next;
    feed.live('BINANCE:BTCUSDT@5', fives(minutes).at(-1) as Bar);
    local.update(minutes, 'tick', 119);
    run.update(minutes, 'tick', 119);
    await settled(run);
    expectSame(run, local);
    const contexts = received.filter((message) => message.kind === 'contexts');
    expect(contexts.map((message) => [message.whole.length, message.tails.length])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('gives a new run on the same feed the contexts others asked for before its first load', async () => {
    const minutes = walk(120);
    const feed = new LoaderLike();
    feed.entries.set('BINANCE:BTCUSDT@5', {
      symbol: { ...CHART, timeframe: '5' },
      bars: fives(minutes),
      live: true,
      fromListing: false,
      version: 1,
      history: 1,
    });
    const p = program(REQUEST);
    const first = inWorker(p, { symbol: CHART, feed });
    first.run.setBars(minutes, false, true);
    await settled(first.run);
    first.run.setBars(minutes, false, true);
    await settled(first.run);
    // Its inputs changed, say: a new run, which needs no second load to find its context.
    const second = inWorker(p, { symbol: CHART, feed, inputs: [] });
    second.run.setBars(minutes, false, true);
    await settled(second.run);
    expect(second.run.waiting).toBe(false);
    expect(second.loads()).toBe(1);
    const local = new ScriptRun(p, [], CHART, feed);
    local.setBars(minutes, false, true);
    expectSame(second.run, local);
  });
});

describe('The chart’s copy of a worker’s results', () => {
  it('takes pages that came while a load ran in one load, with the latest bars', async () => {
    const p = program(SCRIPT);
    const { run, loads, results } = inWorker(p);
    run.setBars(walk(100, 300), false, true);
    run.setBars(walk(200, 200), false, true);
    const latest = walk(400);
    run.setBars(latest, false, true);
    await settled(run);
    expect(loads()).toBe(2);
    expect(results).toEqual(['all', 'all']);
    const local = new ScriptRun(p, []);
    local.setBars(latest, false, true);
    expectSame(run, local);
  });

  it('moves with older bars, and so does a result that was on its way', async () => {
    const p = program(SCRIPT);
    const recent = walk(200, 100);
    const all = walk(300);
    const before = new ScriptRun(p, []);
    before.setBars(recent, false, true);
    const { run } = inWorker(p);
    // The first result moves by the 100 older bars that loaded while it was on its way.
    const seen: number[][] = [];
    run.onResult = () =>
      seen.push(Array.from((run.values[0] as Float64Array).subarray(0, run.length)));
    run.setBars(recent, false, true);
    run.prepended(100);
    run.setBars(all, false, true);
    await settled(run);
    expect(seen).toHaveLength(2);
    const first = seen[0] as number[];
    expect(first).toHaveLength(300);
    expect(first.slice(0, 100).every(Number.isNaN)).toBe(true);
    expect(first.slice(100)).toEqual(
      Array.from((before.values[0] as Float64Array).subarray(0, 200)),
    );
    // Then the run over all of them.
    const after = new ScriptRun(p, []);
    after.setBars(all, false, true);
    expectSame(run, after);
  });

  it('moves what it has at once when older bars load, starts and drawings with it', async () => {
    const p = program(
      indicator(
        'plot(ta.sma(close, 5))\nif barstate.islast\n    label.new(bar_index, close, "last")',
      ),
    );
    const recent = walk(50, 20);
    const { run } = inWorker(p);
    run.setBars(recent, false, false);
    await settled(run);
    const values = Array.from((run.values[0] as Float64Array).subarray(0, 50));
    const start = run.plotStarts[0] as number;
    run.prepended(20);
    expect(run.length).toBe(70);
    expect(Array.from((run.values[0] as Float64Array).subarray(20, 70))).toEqual(values);
    expect(run.plotStarts[0]).toBe(start + 20);
    expect(run.drawings.labels.map((label) => label.x)).toEqual([69]);
  });

  it('lets go of results for bars that were replaced, and waits for the run over the new ones', async () => {
    const p = program(SCRIPT);
    const { run, results } = inWorker(p);
    run.setBars(walk(100), false, true);
    await settled(run);
    expect(results).toEqual(['all']);
    run.setBars(walk(100, 50), false, true);
    run.replaced();
    expect(run.ready).toBe(false);
    expect(run.values).toEqual([]);
    const fresh = walk(120, 70);
    run.setBars(fresh, false, true);
    await settled(run);
    // The result for the replaced bars never reached the chart.
    expect(results).toEqual(['all', 'all']);
    const local = new ScriptRun(p, []);
    local.setBars(fresh, false, true);
    expectSame(run, local);
  });

  it('asks for a load when the worker’s bars aren’t the chart’s', async () => {
    const p = program(SCRIPT);
    const bars = walk(100);
    const { run, loads } = inWorker(p);
    run.setBars(bars, false, true);
    await settled(run);
    // Two bars the worker never saw: its update can't be the chart's, so it loads them all.
    bars.push(walkBar(100), walkBar(101));
    run.update(bars, 'new', 101);
    await settled(run);
    expect(loads()).toBe(2);
    const local = new ScriptRun(p, []);
    local.setBars(bars, false, true);
    expectSame(run, local);
  });

  it('stops its worker when let go, and takes nothing after', async () => {
    const p = program(SCRIPT);
    const { run, results } = inWorker(p);
    run.setBars(walk(100), false, true);
    run.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(results).toEqual([]);
    expect(run.ready).toBe(false);
  });
});
