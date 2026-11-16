import {
  type Bar,
  MarketSchedule,
  type MarketScheduleData,
  sessionClock,
  UTC_CLOCK,
} from '@tradingnerd/core';
import type { DrawingSnapshot, LineObject } from './drawings.ts';
import type { ScriptError } from './execution.ts';
import type { ContextData } from './requests.ts';
import type { LogEntry, ScriptSymbol } from './runtime.ts';
import type { StrategyState, Trade } from './strategy.ts';

/**
 * What crosses between the chart and a script's worker (docs/SPEC.md §6.23), as plain data: a
 * worker's messages are copied by the structured clone algorithm, which refuses functions (MDN,
 * Web Workers API). Bars go as numbers in one buffer that is moved, not copied (MDN, Transferable
 * objects): 48,000 bars pack in about 1 ms, where copying them as objects took 52 ms (measured
 * 2026-11-16).
 */

/** Numbers per bar: time, open, high, low, close, volume, and a tick bar's start (NaN without). */
const STRIDE = 7;

/** Bars `from` to `to` (not included) as STRIDE numbers each, oldest first. */
export function packBars(bars: readonly Bar[], from = 0, to = bars.length): Float64Array {
  const count = Math.max(0, to - from);
  const out = new Float64Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const bar = bars[from + i] as Bar;
    const at = i * STRIDE;
    out[at] = bar.time;
    out[at + 1] = bar.open;
    out[at + 2] = bar.high;
    out[at + 3] = bar.low;
    out[at + 4] = bar.close;
    out[at + 5] = bar.volume;
    out[at + 6] = bar.start ?? Number.NaN;
  }
  return out;
}

/** How many bars a packed buffer holds. */
export const packedCount = (packed: Float64Array): number => packed.length / STRIDE;

/** Bar `i` of a packed buffer, `start` only where it has one (as the gateway sends tick bars). */
export function unpackBar(packed: Float64Array, i: number): Bar {
  const at = i * STRIDE;
  const bar: Bar = {
    time: packed[at] as number,
    open: packed[at + 1] as number,
    high: packed[at + 2] as number,
    low: packed[at + 3] as number,
    close: packed[at + 4] as number,
    volume: packed[at + 5] as number,
  };
  const start = packed[at + 6] as number;
  if (!Number.isNaN(start)) bar.start = start;
  return bar;
}

export function unpackBars(packed: Float64Array): Bar[] {
  const count = packedCount(packed);
  const bars: Bar[] = new Array(count);
  for (let i = 0; i < count; i++) bars[i] = unpackBar(packed, i);
  return bars;
}

/**
 * The last bars of a list as they are now: `packed` holds its bars from place `from` to its end,
 * so the list is `from + packedCount(packed)` long after. The bars before `from` stay as they are.
 */
export function writeTail(bars: Bar[], from: number, packed: Float64Array): void {
  const count = packedCount(packed);
  bars.length = from + count;
  for (let i = 0; i < count; i++) bars[from + i] = unpackBar(packed, i);
}

/** A symbol as a script knows it, without the functions of its clock and calendar. */
export interface WireSymbol extends Omit<ScriptSymbol, 'clock' | 'schedule'> {
  /** Its market's calendar as the gateway sends it; null for one trading around the clock. */
  readonly schedule: MarketScheduleData | null;
}

/**
 * A symbol for a worker. Its clock is the one its calendar and hours make (the app's
 * instrumentOf), or UTC's without one, so the worker can make the same again.
 */
export function wireSymbol(symbol: ScriptSymbol): WireSymbol {
  const { clock, schedule, ...rest } = symbol;
  if (!schedule && clock !== UTC_CLOCK) {
    throw new Error('A symbol whose clock has no calendar cannot be sent to a worker');
  }
  return { ...rest, schedule: schedule ? schedule.data : null };
}

/** The symbol again, its calendar and clock made from the calendar's data and its hours. */
export function symbolFromWire(wire: WireSymbol): ScriptSymbol {
  const schedule = wire.schedule ? new MarketSchedule(wire.schedule) : null;
  return {
    ...wire,
    schedule,
    clock: schedule ? sessionClock(schedule, wire.session) : UTC_CLOCK,
  };
}

/** A request's context for a worker: its symbol, its bars packed, and the rest as they are. */
export interface WireContext {
  readonly symbol: WireSymbol;
  readonly bars: Float64Array;
  readonly live: boolean;
  readonly fromListing: boolean;
  readonly version: number;
  readonly history: number;
  readonly warmup?: number;
}

export function wireContext(data: ContextData): WireContext {
  return {
    symbol: wireSymbol(data.symbol),
    bars: packBars(data.bars),
    live: data.live,
    fromListing: data.fromListing,
    version: data.version,
    history: data.history,
    ...(data.warmup === undefined ? {} : { warmup: data.warmup }),
  };
}

export function contextFromWire(wire: WireContext): ContextData {
  return {
    symbol: symbolFromWire(wire.symbol),
    bars: unpackBars(wire.bars),
    live: wire.live,
    fromListing: wire.fromListing,
    version: wire.version,
    history: wire.history,
    ...(wire.warmup === undefined ? {} : { warmup: wire.warmup }),
  };
}

// ---- results moved by older bars ----

/*
 * A run's results find their bars by position. When `k` older bars load before them, the chart's
 * copy of a run's results moves by `k` until the run over the longer history is done, so what it
 * drew stays on its own bars (docs/SPEC.md §6.23).
 */

/** A bar position moved by `k`; -1 (none) and NaN stay. */
const moved = (bar: number, k: number): number => (bar >= 0 ? bar + k : bar);

/** Values by bar, `k` NaNs before them. */
export function shiftValues(values: Float64Array, k: number): Float64Array {
  if (k === 0) return values;
  const out = new Float64Array(values.length + k);
  out.fill(Number.NaN, 0, k);
  out.set(values, k);
  return out;
}

/** The first bars drawn from (the warm-up rule's starts); Infinity, none yet, stays. */
export const shiftStarts = (starts: readonly number[], k: number): number[] =>
  starts.map((start) => (Number.isFinite(start) ? start + k : start));

/** Drawings placed by bar_index move; those placed by bar_time stay where their times are. */
export function shiftDrawings(drawings: DrawingSnapshot, k: number): DrawingSnapshot {
  if (k === 0) return drawings;
  const x = (value: number, xloc: string) => (xloc === 'bar_time' ? value : value + k);
  const line = (l: LineObject): LineObject => ({ ...l, x1: x(l.x1, l.xloc), x2: x(l.x2, l.xloc) });
  return {
    labels: drawings.labels.map((label) => ({ ...label, x: x(label.x, label.xloc) })),
    lines: drawings.lines.map(line),
    boxes: drawings.boxes.map((box) => ({
      ...box,
      left: x(box.left, box.xloc),
      right: x(box.right, box.xloc),
    })),
    tables: drawings.tables,
    polylines: drawings.polylines.map((poly) => ({
      ...poly,
      points: poly.points.map((point) => ({ ...point, x: x(point.x, poly.xloc) })),
    })),
    linefills: drawings.linefills.map((fill) => ({
      ...fill,
      line1: line(fill.line1),
      line2: line(fill.line2),
    })),
  };
}

/** A strategy's trades, fills and first and last bars, on the bars they were made on. */
export function shiftStrategy(state: StrategyState, k: number): StrategyState {
  if (k === 0) return state;
  const trade = (t: Trade): Trade => ({
    ...t,
    entryOrderBar: moved(t.entryOrderBar, k),
    entryBar: moved(t.entryBar, k),
    exitBar: moved(t.exitBar, k),
  });
  return {
    ...state,
    open: state.open.map(trade),
    closed: state.closed.map(trade),
    fills: state.fills.map((fill) => ({ ...fill, bar: moved(fill.bar, k) })),
    firstBar: moved(state.firstBar, k),
    lastBar: moved(state.lastBar, k),
  };
}

/** Pine Logs entries, each on the bar it was logged on. */
export const shiftLogs = (logs: readonly LogEntry[], k: number): LogEntry[] =>
  k === 0 ? [...logs] : logs.map((entry) => ({ ...entry, bar: moved(entry.bar, k) }));

/** A runtime error, on the bar it stopped on. */
export const shiftError = (error: ScriptError | null, k: number): ScriptError | null =>
  error && k !== 0 ? { ...error, bar: moved(error.bar, k) } : error;
