import { type Bar, libraryPath } from '@tradingnerd/core';
import type { BarChange } from '@tradingnerd/indicators';
import { type DrawingSnapshot, EMPTY_DRAWINGS } from './drawings.ts';
import type { ScriptError } from './execution.ts';
import {
  type ContextData,
  type CurrencyLeg,
  type RequestFeed,
  type RequestKey,
  requestKeyText,
} from './requests.ts';
import { type LogEntry, MAX_LOGS, type ScriptSymbol } from './runtime.ts';
import { compileScript, type ScriptProgram, ScriptRun } from './script.ts';
import type { StrategyState } from './strategy.ts';
import type { Value } from './values.ts';
import {
  contextFromWire,
  packBars,
  packedCount,
  shiftDrawings,
  shiftError,
  shiftLogs,
  shiftStarts,
  shiftStrategy,
  shiftValues,
  symbolFromWire,
  unpackBars,
  type WireContext,
  type WireSymbol,
  wireContext,
  wireSymbol,
  writeTail,
} from './wire.ts';

/**
 * Scripts in a worker of their own (docs/SPEC.md §6.23), so the page never waits on one: the
 * worker's end (ScriptHost) runs the script with the same engine, and the chart's end (RemoteRun)
 * keeps a copy of its results that the chart reads as it reads a run in the page. Both ends are
 * here, so their messages can't drift apart. TradingView runs Pine on its servers for the same
 * reason (Pine docs, Welcome: "cloud-based"); ours is local, so it's a worker.
 */

/** What the chart reads of a script's run, wherever it runs: ScriptRun here, RemoteRun's copy. */
export interface RunResults {
  readonly values: readonly Float64Array[];
  readonly plotColors: readonly (Float64Array | null)[];
  readonly backgrounds: readonly Float64Array[];
  readonly fillColors: readonly (Float64Array | null)[];
  readonly plotStarts: readonly number[];
  readonly backgroundStarts: readonly number[];
  readonly fillStarts: readonly number[];
  readonly error: ScriptError | null;
  readonly missing: readonly RequestKey[];
  readonly requested: readonly RequestKey[];
  readonly waiting: boolean;
  readonly length: number;
  readonly offsets: { plots: (number | null)[]; backgrounds: (number | null)[] };
  readonly drawings: DrawingSnapshot;
  readonly strategy: StrategyState | null;
  readonly logs: readonly LogEntry[];
  readonly logsWritten: number;
}

// ---- the messages ----

/** The script to run: its code, the libraries it may import, its inputs and its symbol. */
export interface StartMessage {
  kind: 'start';
  source: string;
  /** The code of each library scripts can import, by its path ("user/name/1"). */
  libraries: Readonly<Record<string, string>>;
  inputs: readonly Value[];
  symbol: WireSymbol;
}

/** The contexts its requests read, as the chart's feed has them now. */
export interface ContextsMessage {
  kind: 'contexts';
  /** New ones, and those whose history changed: whole. */
  whole: readonly { key: RequestKey; data: WireContext | 'invalid' }[];
  /** Those whose live bars moved: their bars from `from` to their end, as they are now. */
  tails: readonly {
    key: RequestKey;
    from: number;
    bars: Float64Array;
    live: boolean;
    version: number;
  }[];
  /** Those the feed doesn't have any more, by their text. */
  dropped: readonly string[];
}

/** A run afresh over these bars. */
export interface LoadMessage {
  kind: 'load';
  id: number;
  bars: Float64Array;
  fromListing: boolean;
  live: boolean;
}

/** A change to the bars at `index`: the bars from `from` to the end, as they are now. */
export interface UpdateMessage {
  kind: 'update';
  id: number;
  change: BarChange;
  index: number;
  from: number;
  bars: Float64Array;
}

export type ToWorker = StartMessage | ContextsMessage | LoadMessage | UpdateMessage;

/** What a load or an update gave. */
export interface ResultMessage {
  kind: 'result';
  id: number;
  length: number;
  /** 'all': its outputs are whole below; else the bars whose values changed, in `points`. */
  changed: 'all' | readonly number[];
  values: Float64Array[];
  plotColors: (Float64Array | null)[];
  backgrounds: Float64Array[];
  fillColors: (Float64Array | null)[];
  /** Per changed bar, its value in each output (plots, changing plot colors, backgrounds, changing fill colors). */
  points: Float64Array;
  plotStarts: number[];
  backgroundStarts: number[];
  fillStarts: number[];
  error: ScriptError | null;
  missing: RequestKey[];
  requested: RequestKey[];
  offsets: { plots: (number | null)[]; backgrounds: (number | null)[] };
  /** Null when they didn't change since the last result. */
  drawings: DrawingSnapshot | null;
  strategy: StrategyState | null | 'same';
  /** Pine Logs: all of them afresh, or those logged since the last result. */
  logs: { fresh: boolean; entries: LogEntry[]; written: number };
}

export type FromWorker =
  | ResultMessage
  /** The worker's bars weren't the chart's before an update: it needs a load. */
  | { kind: 'resync'; id: number }
  /** Something stopped the worker's run other than a Pine runtime error. */
  | { kind: 'failed'; id: number; message: string };

/** Each output array of a run in a fixed order: plots, changing plot colors, backgrounds, changing fill colors. */
function outputArrays(run: {
  values: readonly Float64Array[];
  plotColors: readonly (Float64Array | null)[];
  backgrounds: readonly Float64Array[];
  fillColors: readonly (Float64Array | null)[];
}): Float64Array[] {
  const out = [...run.values];
  for (const colors of run.plotColors) if (colors) out.push(colors);
  out.push(...run.backgrounds);
  for (const colors of run.fillColors) if (colors) out.push(colors);
  return out;
}

/** The buffers a result moves rather than copies. */
function transferOf(message: ResultMessage): ArrayBuffer[] {
  const arrays = [...outputArrays(message), message.points];
  return arrays.map((array) => array.buffer as ArrayBuffer);
}

// ---- the worker's end ----

/** The contexts the chart sent, as its feed had them: the run's feed in the worker. */
class WireFeed implements RequestFeed {
  private readonly contexts = new Map<string, ContextData | 'invalid'>();
  private readonly finder: ((from: string, to: string) => readonly CurrencyLeg[] | null) | null;

  constructor(finder?: (from: string, to: string) => readonly CurrencyLeg[] | null) {
    this.finder = finder ?? null;
  }

  data(key: RequestKey): ContextData | 'invalid' | null {
    return this.contexts.get(requestKeyText(key)) ?? null;
  }

  rates(from: string, to: string): readonly CurrencyLeg[] | null {
    return this.finder ? this.finder(from, to) : null;
  }

  /**
   * Brings them up to date as the chart's loader changes its own: a context whole when its
   * history changed, else its live bars changed in place with a new version (requestLoader.ts).
   */
  apply(message: ContextsMessage): void {
    for (const text of message.dropped) this.contexts.delete(text);
    for (const { key, data } of message.whole) {
      this.contexts.set(
        requestKeyText(key),
        data === 'invalid' ? 'invalid' : contextFromWire(data),
      );
    }
    for (const tail of message.tails) {
      const text = requestKeyText(tail.key);
      const now = this.contexts.get(text);
      if (!now || now === 'invalid') continue;
      writeTail(now.bars as Bar[], tail.from, tail.bars);
      this.contexts.set(text, { ...now, live: tail.live, version: tail.version });
    }
  }
}

export interface ScriptHostOptions {
  /** How one currency converts into another: the chart's loader's own rule. */
  rates?: (from: string, to: string) => readonly CurrencyLeg[] | null;
}

/**
 * A script's worker: compiles the script as the chart did, keeps its own copy of the chart's
 * bars and of the contexts its requests read, and answers each load and update with the run's
 * results. Messages come in order, so a context sent before a load is there when it runs.
 */
export class ScriptHost {
  private run: ScriptRun | null = null;
  private bars: Bar[] = [];
  private readonly feed: WireFeed;
  private readonly post: (message: FromWorker, transfer: ArrayBuffer[]) => void;
  /** Why the script can't run here, if its compile failed. */
  private startError: string | null = null;
  private sentDrawings: DrawingSnapshot | null = null;
  private sentStrategy: StrategyState | null | undefined = undefined;
  private sentLogs = 0;

  constructor(
    post: (message: FromWorker, transfer: ArrayBuffer[]) => void,
    options: ScriptHostOptions = {},
  ) {
    this.post = post;
    this.feed = new WireFeed(options.rates);
  }

  receive(message: ToWorker): void {
    switch (message.kind) {
      case 'start':
        this.start(message);
        return;
      case 'contexts':
        this.feed.apply(message);
        return;
      case 'load':
        this.answer(message.id, this.load(message));
        return;
      case 'update':
        this.answer(message.id, this.update(message));
        return;
    }
  }

  private start(message: StartMessage): void {
    const { libraries } = message;
    try {
      const compiled = compileScript(message.source, {
        resolveLibrary: (publisher, name, version) =>
          libraries[libraryPath({ publisher, name, version })] ?? null,
      });
      if (!compiled.ok) {
        this.startError = compiled.errors[0]?.message ?? 'The script has an error';
        return;
      }
      this.run = new ScriptRun(
        compiled.program,
        message.inputs,
        symbolFromWire(message.symbol),
        this.feed,
      );
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Answers a load or an update; anything thrown other than a Pine runtime error is told too. */
  private answer(id: number, work: (run: ScriptRun) => FromWorker): void {
    let message: FromWorker;
    try {
      const run = this.run;
      message = run
        ? work(run)
        : { kind: 'failed', id, message: this.startError ?? 'The script has not started' };
    } catch (error) {
      message = {
        kind: 'failed',
        id,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.post(message, message.kind === 'result' ? transferOf(message) : []);
  }

  private load(message: LoadMessage): (run: ScriptRun) => FromWorker {
    return (run) => {
      this.bars = unpackBars(message.bars);
      run.setBars(this.bars, message.fromListing, message.live);
      return this.result(run, message.id, 'all');
    };
  }

  private update(message: UpdateMessage): (run: ScriptRun) => FromWorker {
    return (run) => {
      const length = message.from + packedCount(message.bars);
      // Before the change, its bars must be the chart's: as many, a new bar's aside.
      const before = message.change === 'new' ? length - 1 : length;
      if (this.bars.length !== before || message.from > this.bars.length) {
        return { kind: 'resync', id: message.id };
      }
      writeTail(this.bars, message.from, message.bars);
      return this.result(run, message.id, run.update(this.bars, message.change, message.index));
    };
  }

  private result(run: ScriptRun, id: number, changed: 'all' | readonly number[]): ResultMessage {
    const length = run.length;
    const whole = changed === 'all';
    // Copies as long as the bars: the run's own arrays run past them and go on changing.
    const cut = (array: Float64Array) => array.slice(0, length);
    const arrays = outputArrays(run);
    let points = new Float64Array(0);
    if (!whole) {
      points = new Float64Array(changed.length * arrays.length);
      changed.forEach((bar, c) => {
        arrays.forEach((array, k) => {
          points[c * arrays.length + k] = array[bar] ?? Number.NaN;
        });
      });
    }
    const written = run.logsWritten;
    const fresh = whole || written < this.sentLogs;
    const logged = fresh ? run.logs.length : Math.min(written - this.sentLogs, run.logs.length);
    const message: ResultMessage = {
      kind: 'result',
      id,
      length,
      changed: whole ? 'all' : [...changed],
      values: whole ? run.values.map(cut) : [],
      plotColors: whole ? run.plotColors.map((colors) => colors && cut(colors)) : [],
      backgrounds: whole ? run.backgrounds.map(cut) : [],
      fillColors: whole ? run.fillColors.map((colors) => colors && cut(colors)) : [],
      points,
      plotStarts: [...run.plotStarts],
      backgroundStarts: [...run.backgroundStarts],
      fillStarts: [...run.fillStarts],
      error: run.error,
      missing: [...run.missing],
      requested: [...run.requested],
      offsets: run.offsets,
      drawings: run.drawings === this.sentDrawings ? null : run.drawings,
      strategy: run.strategy === this.sentStrategy ? 'same' : run.strategy,
      logs: { fresh, entries: logged > 0 ? run.logs.slice(-logged) : [], written },
    };
    this.sentDrawings = run.drawings;
    this.sentStrategy = run.strategy;
    this.sentLogs = written;
    return message;
  }
}

// ---- the chart's end ----

/** The contexts the worker-run scripts on one feed ask for, so a new run's worker gets them first. */
class RequestKeys {
  private readonly byRun = new Map<RemoteRun, readonly RequestKey[]>();

  note(run: RemoteRun, keys: readonly RequestKey[]): void {
    this.byRun.set(run, keys);
  }

  forget(run: RemoteRun): void {
    this.byRun.delete(run);
  }

  all(): Map<string, RequestKey> {
    const out = new Map<string, RequestKey>();
    for (const keys of this.byRun.values()) {
      for (const key of keys) out.set(requestKeyText(key), key);
    }
    return out;
  }
}

const registries = new WeakMap<RequestFeed, RequestKeys>();

function keysOf(feed: RequestFeed): RequestKeys {
  let keys = registries.get(feed);
  if (!keys) {
    keys = new RequestKeys();
    registries.set(feed, keys);
  }
  return keys;
}

/** The chart's end of a script's worker. */
export interface WorkerLink {
  /** Sends a message, moving the buffers listed instead of copying them (MDN, Transferable objects). */
  post(message: ToWorker, transfer: ArrayBuffer[]): void;
  /** Stops the worker at once, whatever it's running. */
  close(): void;
}

export interface RemoteRunOptions {
  program: ScriptProgram;
  inputs: readonly unknown[];
  symbol: ScriptSymbol;
  feed?: RequestFeed;
  /** The code of each library the script may import, by its path. */
  libraries?: Readonly<Record<string, string>>;
}

/** Room for this many bars past the last one, so live bars rarely need new arrays (as Execution). */
const SPARE = 1024;

/** Values by bar, grown to hold `length` bars (NaN past those it had). */
function room(array: Float64Array, length: number): Float64Array {
  if (array.length >= length) return array;
  const grown = new Float64Array(length + SPARE).fill(Number.NaN);
  grown.set(array);
  return grown;
}

/** What a sent context was, to send only what changed in it next time. */
interface SentContext {
  data: ContextData | 'invalid';
  length: number;
}

/**
 * A script running in a worker, as the chart sees it: a copy of the worker's results, read as a
 * ScriptRun's are, that `onResult` says has changed. At most one load is out at a time: pages of
 * bars that come meanwhile go in one load with the latest bars, and live changes go in order
 * after it. When older bars load before the chart's bars, the copy moves by them (and so does
 * each result on its way), so what it drew stays on its bars until the run over them is done.
 */
export class RemoteRun implements RunResults {
  readonly program: ScriptProgram;
  readonly inputs: readonly Value[];
  readonly symbol: ScriptSymbol;
  values: Float64Array[] = [];
  plotColors: (Float64Array | null)[] = [];
  backgrounds: Float64Array[] = [];
  fillColors: (Float64Array | null)[] = [];
  plotStarts: number[] = [];
  backgroundStarts: number[] = [];
  fillStarts: number[] = [];
  error: ScriptError | null = null;
  missing: readonly RequestKey[] = [];
  requested: readonly RequestKey[] = [];
  offsets: { plots: (number | null)[]; backgrounds: (number | null)[] } = {
    plots: [],
    backgrounds: [],
  };
  drawings: DrawingSnapshot = EMPTY_DRAWINGS;
  strategy: StrategyState | null = null;
  logs: LogEntry[] = [];
  logsWritten = 0;
  length = 0;
  /** Whether its results are for the chart's bars: none before the first, or after a refill. */
  ready = false;
  /** Called after it took in a result: 'all' when every output may have changed, else these bars. */
  onResult: ((changed: 'all' | readonly number[]) => void) | null = null;
  private readonly link: WorkerLink;
  private readonly feed: RequestFeed | undefined;
  private readonly keys: RequestKeys | null;
  private bars: readonly Bar[] = [];
  private fromListing = false;
  private live = true;
  private nextId = 1;
  /** The load on its way; null when none is. */
  private loading: number | null = null;
  /** A load waits for the one on its way: it takes the latest bars when that one is answered. */
  private queued = false;
  /** Older bars loaded since each message on its way was sent: its result moves by them. */
  private readonly shifts = new Map<number, number>();
  /** Results of messages sent before this one are let go: the bars they were for were replaced. */
  private keepFrom = 0;
  private readonly sent = new Map<string, SentContext>();
  private disposed = false;

  constructor(link: WorkerLink, options: RemoteRunOptions) {
    this.link = link;
    this.program = options.program;
    this.inputs = options.program.sanitize(options.inputs);
    this.symbol = options.symbol;
    this.feed = options.feed;
    this.keys = options.feed ? keysOf(options.feed) : null;
    link.post(
      {
        kind: 'start',
        source: options.program.source,
        libraries: options.libraries ?? {},
        inputs: this.inputs,
        symbol: wireSymbol(options.symbol),
      },
      [],
    );
  }

  get waiting(): boolean {
    return this.missing.length > 0;
  }

  /** Whether a load or an update hasn't been answered yet. */
  get pending(): boolean {
    return this.shifts.size > 0 || this.queued;
  }

  /** A run afresh over these bars (ScriptRun.setBars), now or after the load on its way. */
  setBars(bars: readonly Bar[], fromListing: boolean, live = true): void {
    this.bars = bars;
    this.fromListing = fromListing;
    this.live = live;
    if (this.loading !== null) {
      this.queued = true;
      return;
    }
    this.sendLoad();
  }

  /** A change to the bars at `index` (ScriptRun.update); the result comes through onResult. */
  update(bars: readonly Bar[], change: BarChange, index: number): void {
    this.bars = bars;
    if (this.queued) return;
    if (this.nextId === 1) {
      // Nothing sent yet: a run afresh, as ScriptRun does without one.
      this.setBars(bars, this.fromListing);
      return;
    }
    this.syncContexts();
    const last = bars.length - 1;
    const from =
      change === 'tick'
        ? last
        : change === 'new'
          ? Math.max(0, last - 1)
          : Math.max(0, Math.min(index, last));
    const packed = packBars(bars, from);
    const id = this.nextId++;
    this.shifts.set(id, 0);
    this.link.post({ kind: 'update', id, change, index, from, bars: packed }, [
      packed.buffer as ArrayBuffer,
    ]);
  }

  /** `count` older bars went before the chart's: what it has moves with its bars. */
  prepended(count: number): void {
    if (count <= 0) return;
    for (const [id, shift] of this.shifts) this.shifts.set(id, shift + count);
    this.move(count);
  }

  /** The chart's bars were replaced (a refill): what it has, and results on their way, go. */
  replaced(): void {
    this.keepFrom = this.nextId;
    this.ready = false;
    this.values = [];
    this.plotColors = [];
    this.backgrounds = [];
    this.fillColors = [];
    this.plotStarts = [];
    this.backgroundStarts = [];
    this.fillStarts = [];
    this.error = null;
    this.drawings = EMPTY_DRAWINGS;
    this.strategy = null;
    this.logs = [];
    this.length = 0;
  }

  /** A message from the worker. */
  receive(message: FromWorker): void {
    if (this.disposed) return;
    const shift = this.shifts.get(message.id) ?? 0;
    this.shifts.delete(message.id);
    if (message.id === this.loading) this.loading = null;
    let changed: 'all' | readonly number[] | null = null;
    if (message.kind === 'resync') {
      // Its bars weren't the chart's: what's on its way was run on them too, and goes; a load
      // over the chart's bars follows.
      this.keepFrom = this.nextId;
      this.queued = true;
    } else if (message.id >= this.keepFrom) {
      changed = message.kind === 'result' ? this.take(message, shift) : this.fail(message.message);
    }
    if (this.loading === null && this.queued) this.sendLoad();
    if (changed) this.onResult?.(changed);
  }

  /**
   * Its worker stopped by itself (it couldn't load, or something escaped it): the script stops,
   * saying why, and nothing more is waited for.
   */
  crashed(message: string): void {
    if (this.disposed) return;
    this.shifts.clear();
    this.loading = null;
    this.queued = false;
    this.onResult?.(this.fail(message));
  }

  /** Stops its worker at once. */
  dispose(): void {
    this.disposed = true;
    this.onResult = null;
    this.keys?.forget(this);
    this.link.close();
  }

  private sendLoad(): void {
    this.queued = false;
    this.syncContexts();
    const packed = packBars(this.bars);
    const id = this.nextId++;
    this.loading = id;
    this.shifts.set(id, 0);
    this.link.post(
      { kind: 'load', id, bars: packed, fromListing: this.fromListing, live: this.live },
      [packed.buffer as ArrayBuffer],
    );
  }

  private take(r: ResultMessage, k: number): 'all' | readonly number[] {
    if (r.changed === 'all') {
      this.values = r.values.map((values) => shiftValues(values, k));
      this.plotColors = r.plotColors.map((colors) => colors && shiftValues(colors, k));
      this.backgrounds = r.backgrounds.map((colors) => shiftValues(colors, k));
      this.fillColors = r.fillColors.map((colors) => colors && shiftValues(colors, k));
    } else {
      this.write(r.changed, r.points, k, r.length + k);
    }
    this.length = r.length + k;
    this.plotStarts = shiftStarts(r.plotStarts, k);
    this.backgroundStarts = shiftStarts(r.backgroundStarts, k);
    this.fillStarts = shiftStarts(r.fillStarts, k);
    this.error = shiftError(r.error, k);
    this.missing = r.missing;
    this.requested = r.requested;
    this.offsets = r.offsets;
    if (r.drawings) this.drawings = shiftDrawings(r.drawings, k);
    if (r.strategy !== 'same') this.strategy = r.strategy && shiftStrategy(r.strategy, k);
    if (r.logs.fresh) {
      this.logs = shiftLogs(r.logs.entries, k);
    } else if (r.logs.entries.length > 0) {
      // New entries join the list in place, as a run's own do; its count says it changed.
      this.logs.push(...shiftLogs(r.logs.entries, k));
      if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    }
    this.logsWritten = r.logs.written;
    this.ready = true;
    this.keys?.note(this, [...r.requested, ...r.missing]);
    return r.changed === 'all' ? 'all' : r.changed.map((bar) => bar + k);
  }

  /** The changed bars' values, into its own arrays (grown for a new bar). */
  private write(changed: readonly number[], points: Float64Array, k: number, length: number): void {
    this.values = this.values.map((values) => room(values, length));
    this.plotColors = this.plotColors.map((colors) => colors && room(colors, length));
    this.backgrounds = this.backgrounds.map((colors) => room(colors, length));
    this.fillColors = this.fillColors.map((colors) => colors && room(colors, length));
    const arrays = outputArrays(this);
    changed.forEach((bar, c) => {
      arrays.forEach((array, j) => {
        array[bar + k] = points[c * arrays.length + j] as number;
      });
    });
  }

  /** A failure other than a Pine runtime error: the script stops, saying why. */
  private fail(message: string): 'all' {
    this.error = { message, span: null, bar: 0 };
    this.ready = true;
    return 'all';
  }

  /** What it has, moved by `k` older bars. */
  private move(k: number): void {
    this.values = this.values.map((values) => shiftValues(values, k));
    this.plotColors = this.plotColors.map((colors) => colors && shiftValues(colors, k));
    this.backgrounds = this.backgrounds.map((colors) => shiftValues(colors, k));
    this.fillColors = this.fillColors.map((colors) => colors && shiftValues(colors, k));
    if (this.ready) this.length += k;
    this.plotStarts = shiftStarts(this.plotStarts, k);
    this.backgroundStarts = shiftStarts(this.backgroundStarts, k);
    this.fillStarts = shiftStarts(this.fillStarts, k);
    this.error = shiftError(this.error, k);
    this.drawings = shiftDrawings(this.drawings, k);
    this.strategy = this.strategy && shiftStrategy(this.strategy, k);
    this.logs = shiftLogs(this.logs, k);
  }

  /**
   * Sends the worker what changed in the contexts the feed has for the scripts' requests: those
   * this run's last result named, and those other runs on the feed did (a new run's first load
   * finds them there). Whole when new or when their history changed; else their bars from the
   * last one sent, which a live update changes in place.
   */
  private syncContexts(): void {
    const feed = this.feed;
    if (!feed || !this.keys) return;
    const wanted = this.keys.all();
    const whole: ContextsMessage['whole'][number][] = [];
    const tails: ContextsMessage['tails'][number][] = [];
    const dropped: string[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const text of this.sent.keys()) {
      if (!wanted.has(text)) {
        dropped.push(text);
        this.sent.delete(text);
      }
    }
    for (const [text, key] of wanted) {
      const data = feed.data(key);
      const before = this.sent.get(text);
      if (data === null) {
        if (before) {
          dropped.push(text);
          this.sent.delete(text);
        }
        continue;
      }
      if (before?.data === data) continue;
      if (data === 'invalid') {
        whole.push({ key, data });
        this.sent.set(text, { data, length: 0 });
        continue;
      }
      const prior = before?.data;
      const extends_ =
        prior !== undefined &&
        prior !== 'invalid' &&
        prior.bars === data.bars &&
        prior.history === data.history &&
        prior.symbol === data.symbol &&
        data.bars.length >= (before?.length ?? 0);
      if (extends_ && before) {
        const from = Math.max(0, before.length - 1);
        const bars = packBars(data.bars, from);
        tails.push({ key, from, bars, live: data.live, version: data.version });
        transfer.push(bars.buffer as ArrayBuffer);
      } else {
        const wire = wireContext(data);
        whole.push({ key, data: wire });
        transfer.push(wire.bars.buffer as ArrayBuffer);
      }
      this.sent.set(text, { data, length: data.bars.length });
    }
    if (whole.length > 0 || tails.length > 0 || dropped.length > 0) {
      this.link.post({ kind: 'contexts', whole, tails, dropped }, transfer);
    }
  }
}
