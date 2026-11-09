import type { Bar } from '@tradingnerd/core';

/**
 * Non-standard charts' bars made from a symbol's own, for requests with ticker.renko(),
 * ticker.linebreak(), ticker.kagi() and ticker.pointfigure() (Pine docs: Non-standard charts
 * data; the v6 reference). TradingView's own rules where it gives them:
 * - Renko: "to create a new brick that moves in the same direction as the last one, the price
 *   needs to move 1x Box Size in that direction"; a reversal "needs to move 2x Box Size"; the
 *   bricks' open and close "are synthetic and are always divisible by the chart's Box Size";
 *   wicks are real prices, a high only on a brick going down, a low only on one going up (Help
 *   Center, Renko charts and "What do Renko wicks mean?").
 * - Box sizes: ATR "calculates what the ATR value would be in a regular candlestick chart and
 *   then uses this value"; a percentage "is applied to the most recent closing price … then
 *   rounded to the nearest minimum tick size and applied consistently across all bars" (Help
 *   Center, Kagi and Point & Figure charts).
 * - Line Break: a line in the same direction when the close passes the last line's end; the
 *   other way only when it passes the extreme of the last `number_of_lines` lines (Help Center,
 *   Line Break charts).
 * - Point & Figure: a new column after `reversal` boxes the other way (Help Center).
 * What TradingView doesn't say is provisional (docs/SPEC.md §11, item 130): where the grid
 * starts (the first close's nearest box), each bar's time (a brick or a line where it formed, a
 * Kagi line or a column where it last grew, so no bar shows a price before it happened), its
 * volume (the source bars' since the bar before), the first Kagi line (once the price has moved a
 * reversal from the first close), OHLC's path through a bar (the broker emulator's), and a
 * column's open and close (its first and its last box).
 */

/** The settings a ticker id carries for its type: ticker.renko()'s style, param and so on. */
export type ChartTypeInputs = Readonly<Record<string, string | number | boolean>>;

/** The non-standard types made here (Heikin Ashi is requests.ts's own). */
export const CHART_TYPES: readonly string[] = ['renko', 'linebreak', 'kagi', 'pointfigure'];

/** How a box (or a Kagi reversal) is sized: a price, an ATR length, or a percent of the last close. */
const STYLES: readonly string[] = ['ATR', 'Traditional', 'PercentageLTP'];

const NAMES: Readonly<Record<string, string>> = {
  renko: 'Renko',
  linebreak: 'Line Break',
  kagi: 'Kagi',
  pointfigure: 'Point & Figure',
};

const numberOf = (inputs: ChartTypeInputs, name: string): number => {
  const value = inputs[name];
  return typeof value === 'number' ? value : Number.NaN;
};

/** Why a type's settings can't make bars, in plain words; null when they can. */
export function chartTypeProblem(type: string, inputs: ChartTypeInputs): string | null {
  const name = NAMES[type];
  if (!name) return `Unknown chart type "${type}"`;
  if (type === 'linebreak') {
    const lines = numberOf(inputs, 'lines');
    return Number.isInteger(lines) && lines >= 1
      ? null
      : `Line Break's number of lines must be a whole number from 1: ${String(inputs.lines)}`;
  }
  const style = String(inputs.style ?? '');
  if (!STYLES.includes(style)) {
    return `Invalid ${name} style "${style}": it can be "ATR", "Traditional" or "PercentageLTP"`;
  }
  const param = numberOf(inputs, 'param');
  if (style === 'ATR' && !(Number.isInteger(param) && param >= 1)) {
    return `${name}'s ATR length must be a whole number from 1: ${String(inputs.param)}`;
  }
  if (!(param > 0)) {
    const what =
      style === 'PercentageLTP' ? 'percentage' : type === 'kagi' ? 'reversal' : 'box size';
    return `${name}'s ${what} must be above 0: ${String(inputs.param)}`;
  }
  if (type === 'pointfigure') {
    const reversal = numberOf(inputs, 'reversal');
    if (!(Number.isInteger(reversal) && reversal >= 1)) {
      return `Point & Figure's reversal must be a whole number of boxes from 1: ${String(inputs.reversal)}`;
    }
    if (inputs.source !== 'hl' && inputs.source !== 'close') {
      return `Invalid Point & Figure source "${String(inputs.source)}": it can be "hl" or "close"`;
    }
  }
  if (type === 'renko' && inputs.source !== 'Close' && inputs.source !== 'OHLC') {
    return `Invalid Renko source "${String(inputs.source)}": it can be "Close" or "OHLC"`;
  }
  return null;
}

/** Wilder's ATR of `length` bars at the last bar (ta.atr's), NaN without enough bars. */
export function lastAtr(bars: readonly Bar[], length: number): number {
  const n = Math.max(1, Math.floor(length));
  if (bars.length < n) return Number.NaN;
  let atr = Number.NaN;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as Bar;
    const before = bars[i - 1];
    const tr = before
      ? Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - before.close),
          Math.abs(bar.low - before.close),
        )
      : bar.high - bar.low;
    if (i < n) {
      sum += tr;
      if (i === n - 1) atr = sum / n;
    } else {
      atr = (atr * (n - 1) + tr) / n;
    }
  }
  return atr;
}

/**
 * A box size (or a Kagi reversal) from its style: a Traditional one as given, a worked-out one
 * rounded to the tick and at least one tick; NaN when it can't be worked out (an ATR longer
 * than the bars).
 */
export function boxSize(
  style: string,
  param: number,
  bars: readonly Bar[],
  mintick: number,
): number {
  let size = param;
  if (style === 'ATR') size = lastAtr(bars, param);
  else if (style === 'PercentageLTP') size = ((bars.at(-1)?.close ?? Number.NaN) * param) / 100;
  if (!(size > 0)) return Number.NaN;
  if (style === 'Traditional' || !(mintick > 0)) return size;
  return Math.max(mintick, Math.round(size / mintick) * mintick);
}

/** A synthetic bar under construction. */
interface Building {
  time: number;
  start?: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** The made bar: its high and low at least its open and close. */
const toBar = (b: Building): Bar => ({
  time: b.time,
  ...(b.start !== undefined ? { start: b.start } : {}),
  open: b.open,
  high: Math.max(b.high, b.open, b.close),
  low: Math.min(b.low, b.open, b.close),
  close: b.close,
  volume: b.volume,
});

/** A source bar's time as the made bar carries it (a tick bar's number and its moment). */
const timeOf = (bar: Bar): { time: number; start?: number } =>
  bar.start !== undefined ? { time: bar.time, start: bar.start } : { time: bar.time };

/** The prices a source bar goes through: its close, or its open, high, low and close in order. */
function pathOf(bar: Bar, ohlc: boolean): number[] {
  if (!ohlc) return [bar.close];
  // The broker emulator's order: the high first when the open is nearer it (Pine docs, Strategies).
  return bar.high - bar.open <= bar.open - bar.low
    ? [bar.open, bar.high, bar.low, bar.close]
    : [bar.open, bar.low, bar.high, bar.close];
}

/**
 * Renko bricks of `box`: from the first close's nearest box, a brick each time the price moves a
 * box past the last brick's end, two boxes for a reversal. The last brick's top and bottom are
 * all it needs: going up, its bottom is its open, so a box under its bottom is two under its
 * close; going down, the same the other way.
 */
export function renkoBars(
  bars: readonly Bar[],
  box: number,
  options: { wicks?: boolean; ohlc?: boolean } = {},
): Bar[] {
  const out: Bar[] = [];
  if (!(box > 0) || bars.length === 0) return out;
  // The grid's levels as whole numbers of boxes, so a brick's prices are the same however the
  // bricks before it came (adding boxes up would drift by a rounding error).
  let top = Math.round((bars[0] as Bar).close / box);
  let bottom = top;
  let volume = 0;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  const eps = box * 1e-9;
  for (const bar of bars) {
    volume += bar.volume;
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    const push = (from: number, to: number) => {
      const open = from * box;
      const close = to * box;
      const brick: Building = { ...timeOf(bar), open, close, high: open, low: open, volume };
      if (options.wicks) {
        // A low wick only on a brick going up, a high wick only on one going down (Help Center).
        if (close > open && low < open) brick.low = low;
        if (close < open && high > open) brick.high = high;
      }
      out.push(toBar(brick));
      volume = 0;
      high = Number.NEGATIVE_INFINITY;
      low = Number.POSITIVE_INFINITY;
    };
    for (const price of pathOf(bar, options.ohlc === true)) {
      for (;;) {
        if (price >= (top + 1) * box - eps) {
          push(top, top + 1);
          bottom = top;
          top += 1;
        } else if (price <= (bottom - 1) * box + eps) {
          push(bottom, bottom - 1);
          top = bottom;
          bottom -= 1;
        } else break;
      }
    }
  }
  return out;
}

/** Line Break's lines: `lines` of them back decide a reversal. */
export function lineBreakBars(bars: readonly Bar[], lines: number): Bar[] {
  const n = Math.max(1, Math.floor(lines));
  const out: Building[] = [];
  if (bars.length === 0) return [];
  const start = (bars[0] as Bar).close;
  let volume = 0;
  for (const bar of bars) {
    volume += bar.volume;
    const c = bar.close;
    const make = (open: number) => {
      out.push({ ...timeOf(bar), open, close: c, high: open, low: open, volume });
      volume = 0;
    };
    const last = out.at(-1);
    if (!last) {
      // The first line: from the first close to the first that differs.
      if (c !== start) make(start);
      continue;
    }
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    for (let k = Math.max(0, out.length - n); k < out.length; k++) {
      const line = out[k] as Building;
      highest = Math.max(highest, line.open, line.close);
      lowest = Math.min(lowest, line.open, line.close);
    }
    if (last.close > last.open) {
      if (c > last.close) make(last.close);
      else if (c < lowest) make(last.open);
    } else if (c < last.close) {
      make(last.close);
    } else if (c > highest) {
      make(last.open);
    }
  }
  return out.map(toBar);
}

/** Kagi's lines: a line grows while the price goes its way and turns after a `reversal` move. */
export function kagiBars(bars: readonly Bar[], reversal: number): Bar[] {
  const out: Building[] = [];
  if (!(reversal > 0) || bars.length === 0) return [];
  const start = (bars[0] as Bar).close;
  const eps = reversal * 1e-9;
  let volume = 0;
  for (const bar of bars) {
    volume += bar.volume;
    const p = bar.close;
    const add = (open: number) => {
      out.push({ ...timeOf(bar), open, close: p, high: open, low: open, volume });
      volume = 0;
    };
    const line = out.at(-1);
    if (!line) {
      if (Math.abs(p - start) >= reversal - eps) add(start);
      continue;
    }
    const up = line.close > line.open;
    if (up ? p > line.close : p < line.close) {
      // The line grows, and carries the time it last grew.
      Object.assign(line, timeOf(bar));
      line.close = p;
      line.volume += volume;
      volume = 0;
    } else if (up ? p <= line.close - reversal + eps : p >= line.close + reversal - eps) {
      add(line.close);
    }
  }
  return out.map(toBar);
}

/**
 * Point & Figure's columns of `box`: a column of X's grows while the price rises a box at a time,
 * and turns into O's after `reversal` boxes down (and the other way), from the bars' highs and
 * lows ("hl") or their closes. A column's open is its first box, its close its last: a column of
 * one box has them equal.
 */
export function pointFigureBars(
  bars: readonly Bar[],
  box: number,
  reversal: number,
  source: 'hl' | 'close',
): Bar[] {
  if (!(box > 0) || bars.length === 0) return [];
  const r = Math.max(1, Math.floor(reversal));
  // Boxes as whole numbers of them (as Renko's), each column's first and last.
  const below = (p: number) => Math.floor(p / box + 1e-9);
  const above = (p: number) => Math.ceil(p / box - 1e-9);
  const level = Math.round((bars[0] as Bar).close / box);
  const columns: { time: number; start?: number; first: number; last: number; volume: number }[] =
    [];
  // Whether the last column is X's.
  let xs = false;
  let volume = 0;
  for (const bar of bars) {
    volume += bar.volume;
    const hi = below(source === 'hl' ? bar.high : bar.close);
    const lo = above(source === 'hl' ? bar.low : bar.close);
    const add = (first: number, last: number, x: boolean) => {
      columns.push({ ...timeOf(bar), first, last, volume });
      xs = x;
      volume = 0;
    };
    const grow = (last: number) => {
      const col = columns.at(-1) as (typeof columns)[number];
      Object.assign(col, timeOf(bar));
      col.last = last;
      col.volume += volume;
      volume = 0;
    };
    const col = columns.at(-1);
    if (!col) {
      if (hi >= level + 1) add(level + 1, hi, true);
      else if (lo <= level - 1) add(level - 1, lo, false);
    } else if (xs) {
      // An X column grows on a new high; only when it doesn't can the low turn it.
      if (hi >= col.last + 1) grow(hi);
      else if (lo <= col.last - r) add(col.last - 1, lo, false);
    } else if (lo <= col.last - 1) {
      grow(lo);
    } else if (hi >= col.last + r) {
      add(col.last + 1, hi, true);
    }
  }
  return columns.map((col) => {
    const open = col.first * box;
    const close = col.last * box;
    const { first: _first, last: _last, ...time } = col;
    return toBar({ ...time, open, close, high: open, low: open });
  });
}

/** The maker of a type's bars, its box size worked out once from all the source bars. */
export function chartTypeMaker(
  type: string,
  inputs: ChartTypeInputs,
  source: readonly Bar[],
  mintick: number,
): ((bars: readonly Bar[]) => Bar[]) | null {
  if (chartTypeProblem(type, inputs) !== null) return null;
  if (type === 'linebreak') {
    const lines = numberOf(inputs, 'lines');
    return (bars) => lineBreakBars(bars, lines);
  }
  const size = boxSize(String(inputs.style), numberOf(inputs, 'param'), source, mintick);
  switch (type) {
    case 'renko': {
      const options = { wicks: inputs.wicks === true, ohlc: inputs.source === 'OHLC' };
      return (bars) => renkoBars(bars, size, options);
    }
    case 'kagi':
      return (bars) => kagiBars(bars, size);
    case 'pointfigure': {
      const reversal = numberOf(inputs, 'reversal');
      const from = inputs.source === 'close' ? 'close' : 'hl';
      return (bars) => pointFigureBars(bars, size, reversal, from);
    }
    default:
      return null;
  }
}

const sameBar = (a: Bar, b: Bar): boolean =>
  a.time === b.time &&
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close &&
  a.volume === b.volume;

/**
 * Where made bars stop depending on where the source bars start: the warm-up rule's idea for
 * them (docs/SPEC.md §6.17). TradingView builds from further back than our first bar, so a made
 * bar is trusted only from where bars made from a later start are the same to the end. The checks
 * start one bar later and just after the first made bar; the result is an index into `made` (its
 * length when they never meet).
 */
export function settledFrom(
  made: readonly Bar[],
  make: (bars: readonly Bar[]) => Bar[],
  source: readonly Bar[],
): number {
  if (made.length === 0) return 0;
  const firstTime = (made[0] as Bar).time;
  const afterFirst = source.findIndex((bar) => bar.time > firstTime);
  const starts = new Set([1, afterFirst].filter((s) => s > 0 && s < source.length));
  let settled = 0;
  for (const start of starts) {
    const other = make(source.slice(start));
    let i = made.length - 1;
    let j = other.length - 1;
    while (i >= 0 && j >= 0 && sameBar(made[i] as Bar, other[j] as Bar)) {
      i--;
      j--;
    }
    settled = Math.max(settled, i + 1);
  }
  return settled;
}

/** Whether `next` is `prev` with its last bar changed or bars added after it. */
export function extendsBars(prev: readonly Bar[], next: readonly Bar[]): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length - 1; i++) {
    if (!sameBar(prev[i] as Bar, next[i] as Bar)) return false;
  }
  return true;
}

/** Whether two lists of bars are the same. */
export function sameBars(a: readonly Bar[], b: readonly Bar[]): boolean {
  return a.length === b.length && a.every((bar, i) => sameBar(bar, b[i] as Bar));
}
