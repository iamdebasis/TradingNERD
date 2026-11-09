import { scriptInputs } from '@tradingnerd/chart';
import {
  type CompileResult,
  type ContextData,
  canonicalTimeframe,
  fillPlaceholders,
  type PlaceholderContext,
  type RequestFeed,
  type RequestKey,
  ScriptRun,
  type StrategyFill,
} from '@tradingnerd/pine';
import type { ChartReach } from '../chart/requestLoader';
import {
  type AlertDef,
  ORDER_FILL_MESSAGE,
  TriggerState,
  takesCalls,
  takesFills,
} from './alertModel';

/** The data alerts run on: the app's request loader, or a test's. */
export interface AlertFeed extends RequestFeed {
  want(missing: readonly RequestKey[], used: readonly RequestKey[], reach: ChartReach): void;
  dispose(): void;
}

export interface AlertRunnerOptions {
  /** Its own loader (AlertsHost: a RequestLoader), told when bars load or move. */
  makeFeed(callbacks: { onHistory(): void; onLive(): void }): AlertFeed;
  /** Compiles an alert's copy of its script (with the libraries it imports). */
  compile(source: string): CompileResult;
  onFire(alert: AlertDef, message: string, time: number): void;
  /** Why an alert can't run (its script's compile or runtime error); null once it runs. */
  onError?(alert: AlertDef, message: string | null): void;
  now?(): number;
}

/** One alert running: its copy of the script on its symbol and timeframe. */
interface Running {
  def: AlertDef;
  key: RequestKey;
  program: Extract<CompileResult, { ok: true }>['program'] | null;
  run: ScriptRun | null;
  /** The data its run has: its version and history, and how many bars. */
  version: number;
  history: number;
  length: number;
  /** Its first realtime bar: fills before it are history. */
  realtimeFrom: number;
  fillsSeen: number;
  state: TriggerState;
  /** An "Only once" alert that triggered: it waits to be stopped. */
  done: boolean;
  error: string | null;
}

/** The chart's reach doesn't apply: an alert's data is one page back from now. */
const REACH: ChartReach = { firstBarTime: null, timeframe: '1D' };

/**
 * Runs the active alerts while the app is open (alertModel.ts): each its own copy of the script
 * on its own symbol and timeframe, whatever the chart shows, as TradingView runs an alert on what
 * it was made on. After each live update it takes the run's alert() events, its alertcondition()
 * values and a strategy's new fills, and reports what triggers. Events of runs afresh (history
 * loading, a correction) are let go: "alerts only trigger in the realtime bar", on its updates.
 */
export class AlertRunner {
  private readonly options: AlertRunnerOptions;
  private readonly running = new Map<string, Running>();
  private readonly feed: AlertFeed;
  private readonly now: () => number;

  constructor(options: AlertRunnerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.feed = options.makeFeed({
      onHistory: () => this.refresh('history'),
      onLive: () => this.refresh('live'),
    });
  }

  /** The alerts as they stand: active ones run (an edited one afresh), the others stop. */
  setAlerts(alerts: readonly AlertDef[]): void {
    const active = alerts.filter((alert) => alert.status === 'active');
    const ids = new Set(active.map((alert) => alert.id));
    for (const id of [...this.running.keys()]) if (!ids.has(id)) this.running.delete(id);
    for (const def of active) {
      if (this.running.get(def.id)?.def === def) continue;
      this.running.set(def.id, this.start(def));
    }
    this.want();
    this.refresh('history');
  }

  /** Every alert afresh: their scripts compile again (the libraries they import changed). */
  reset(alerts: readonly AlertDef[]): void {
    this.running.clear();
    this.setAlerts(alerts);
  }

  /** Whether an alert is running now (tests and the panel). */
  isRunning(id: string): boolean {
    return this.running.get(id)?.run != null;
  }

  dispose(): void {
    this.running.clear();
    this.feed.dispose();
  }

  private start(def: AlertDef): Running {
    const compiled = this.options.compile(def.script.source);
    const error = compiled.ok ? null : (compiled.errors[0]?.message ?? 'The script has an error');
    if (error) this.options.onError?.(def, error);
    return {
      def,
      key: {
        symbol: def.symbol.toUpperCase(),
        timeframe: canonicalTimeframe(def.interval) ?? def.interval,
      },
      program: compiled.ok ? compiled.program : null,
      run: null,
      version: -1,
      history: -1,
      length: 0,
      realtimeFrom: 0,
      fillsSeen: 0,
      state: new TriggerState(),
      done: false,
      error,
    };
  }

  /** Its loader keeps each alert's symbol and the contexts its script requests. */
  private want(): void {
    const used: RequestKey[] = [];
    const missing: RequestKey[] = [];
    for (const r of this.running.values()) {
      used.push(r.key);
      if (r.run) {
        used.push(...r.run.requested);
        missing.push(...r.run.missing);
      }
    }
    this.feed.want(missing, used, REACH);
  }

  private refresh(kind: 'history' | 'live'): void {
    for (const r of this.running.values()) {
      if (!r.program || r.done) continue;
      const data = this.feed.data(r.key);
      if (!data) continue;
      if (data === 'invalid') {
        this.fail(r, `Invalid symbol "${r.key.symbol}"`);
        continue;
      }
      // A context its script waited for came in: it runs afresh.
      const waited = kind === 'history' && r.run !== null && r.run.waiting;
      this.advance(r, data, waited);
    }
    this.want();
  }

  private advance(r: Running, data: ContextData, afresh: boolean): void {
    const bars = data.bars;
    const program = r.program as NonNullable<Running['program']>;
    if (!r.run) {
      r.run = new ScriptRun(
        program,
        scriptInputs(program, r.def.script.inputs),
        data.symbol,
        this.feed,
      );
      r.run.watchAlerts();
    }
    const run = r.run;
    if (afresh || data.history !== r.history) {
      run.setBars(bars, data.fromListing, data.live);
      this.settled(r, data);
      return;
    }
    if (data.version === r.version) return;
    const last = bars.length - 1;
    const change = bars.length === r.length ? 'tick' : bars.length === r.length + 1 ? 'new' : null;
    const result = change ? run.update(bars, change, last) : 'all';
    if (!change) run.setBars(bars, data.fromListing, data.live);
    if (result === 'all') {
      this.settled(r, data);
      return;
    }
    r.version = data.version;
    r.length = bars.length;
    this.check(r);
    this.evaluate(r, data, change === 'new');
  }

  /** After a run afresh: its events let go, its fills so far history. */
  private settled(r: Running, data: ContextData): void {
    const run = r.run as ScriptRun;
    run.takeAlerts();
    r.history = data.history;
    r.version = data.version;
    r.length = data.bars.length;
    r.realtimeFrom = data.live ? Math.max(0, data.bars.length - 1) : data.bars.length;
    r.fillsSeen = run.strategy?.fills.length ?? 0;
    this.check(r);
  }

  /** A runtime error stops the alert's script: the panel says why. */
  private check(r: Running): void {
    const error = r.run?.error?.message ?? null;
    if (error !== r.error) {
      r.error = error;
      this.options.onError?.(r.def, error);
    }
  }

  private fail(r: Running, message: string): void {
    if (r.error === message) return;
    r.error = message;
    this.options.onError?.(r.def, message);
  }

  /** What triggers on this update: alert() calls, alertcondition() values, order fills. */
  private evaluate(r: Running, data: ContextData, opened: boolean): void {
    const run = r.run as ScriptRun;
    const { def, state } = r;
    const bars = data.bars;
    const now = this.now();
    const timeOf = (bar: number) => bars[bar]?.time ?? 0;
    const events = run.takeAlerts();
    if (takesCalls(def.condition)) {
      for (const event of events) {
        if (event.bar < r.realtimeFrom) continue;
        if (state.callFires(event, timeOf(event.bar))) this.options.onFire(def, event.message, now);
      }
    }
    if (def.condition.kind === 'condition') {
      const index = def.condition.index;
      const last = bars.length - 1;
      // A new bar: the one before it closed (its run final), and the new one's first run.
      const runs: [number, boolean][] = opened
        ? [
            [last - 1, true],
            [last, false],
          ]
        : [[last, false]];
      for (const [bar, final] of runs) {
        if (bar < r.realtimeFrom || r.done) continue;
        const value = run.conditionOn(index, bar) === true;
        if (!state.conditionFires(def.trigger, value, final, timeOf(bar), now)) continue;
        this.options.onFire(
          def,
          fillPlaceholders(def.message, this.context(r, data, bar, now)),
          now,
        );
        if (def.trigger === 'once') r.done = true;
      }
    }
    if (takesFills(def.condition)) {
      const fills = run.strategy?.fills ?? [];
      if (fills.length < r.fillsSeen) r.fillsSeen = fills.length;
      for (const fill of fills.slice(r.fillsSeen)) {
        if (fill.bar < r.realtimeFrom) continue;
        const ctx = { ...this.context(r, data, fill.bar, now), order: orderOf(fill) };
        this.options.onFire(def, fillPlaceholders(def.message || ORDER_FILL_MESSAGE, ctx), now);
      }
      r.fillsSeen = fills.length;
    }
  }

  /** What its message's placeholders read on bar `bar`. */
  private context(r: Running, data: ContextData, bar: number, now: number): PlaceholderContext {
    const run = r.run as ScriptRun;
    const b = data.bars[bar];
    const symbol = r.key.symbol;
    const colon = symbol.indexOf(':');
    // {{plot_N}} counts the script's plots in their order; a candle's other parts aren't plots.
    const plots = run.description.plots.flatMap((plot, p) =>
      plot.kind === 'part'
        ? []
        : [{ title: plot.title, value: run.values[p]?.[bar] ?? Number.NaN }],
    );
    return {
      exchange: colon < 0 ? '' : symbol.slice(0, colon),
      ticker: colon < 0 ? symbol : symbol.slice(colon + 1),
      interval: r.def.interval,
      bar: b
        ? {
            time: b.start ?? b.time * 1000,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }
        : {
            time: Number.NaN,
            open: Number.NaN,
            high: Number.NaN,
            low: Number.NaN,
            close: Number.NaN,
            volume: Number.NaN,
          },
      now,
      plots,
    };
  }
}

/** An order fill as its alert's {{strategy.*}} placeholders read it. */
function orderOf(fill: StrategyFill): NonNullable<PlaceholderContext['order']> {
  const side = (size: number): 'long' | 'short' | 'flat' =>
    size > 0 ? 'long' : size < 0 ? 'short' : 'flat';
  return {
    action: fill.qty > 0 ? 'buy' : 'sell',
    contracts: Math.abs(fill.qty),
    price: fill.price,
    id: fill.id,
    comment: fill.comment,
    alertMessage: fill.alertMessage,
    positionSize: fill.position,
    marketPosition: side(fill.position),
    prevMarketPosition: side(fill.position - fill.qty),
  };
}
