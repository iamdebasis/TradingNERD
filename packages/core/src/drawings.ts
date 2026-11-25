import type { Resolution } from './resolution.ts';

/**
 * The user's drawings on the chart (docs/SPEC.md §5.27, milestone D1): TradingView's drawing
 * tools, each a few anchor points (a bar's time and a price) with its style. The gateway keeps
 * them per symbol in `data/drawings.json`; a drawing shows on every interval unless its
 * Visibility tab says otherwise, as on TradingView (Help Center, How to set drawing visibility on
 * different intervals).
 *
 * Defaults are TradingView's as far as they're known: the line tools' blue #2962FF at 2 px comes
 * from a third-party capture of TradingView's factory defaults (deepentropy/lightweight-charts-
 * drawing, MIT) and agrees with TradingView's own Path tool default (Charting Library docs,
 * PathLineToolOverrides). Provisional until measured from the user's screenshots (§11).
 */

/** The Lines section of TradingView's trend line tools, in its menu's order (the user's screenshot). */
export const LINE_TOOLS = [
  'trend-line',
  'ray',
  'info-line',
  'extended-line',
  'trend-angle',
  'horizontal-line',
  'horizontal-ray',
  'vertical-line',
  'cross-line',
] as const;

/** Every tool a drawing can be made with (D2 adds channels and pitchforks). */
export const DRAWING_TOOLS = LINE_TOOLS;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];

export function isDrawingTool(value: unknown): value is DrawingTool {
  return typeof value === 'string' && (DRAWING_TOOLS as readonly string[]).includes(value);
}

/** TradingView's names, as its menu writes them (the user's screenshot of 25 November). */
export const TOOL_NAMES: Record<DrawingTool, string> = {
  'trend-line': 'Trendline',
  ray: 'Ray',
  'info-line': 'Info line',
  'extended-line': 'Extended line',
  'trend-angle': 'Trend angle',
  'horizontal-line': 'Horizontal line',
  'horizontal-ray': 'Horizontal ray',
  'vertical-line': 'Vertical line',
  'cross-line': 'Crossline',
};

/** How many points place each tool: one click, or two. */
export const TOOL_POINTS: Record<DrawingTool, 1 | 2> = {
  'trend-line': 2,
  ray: 2,
  'info-line': 2,
  'extended-line': 2,
  'trend-angle': 2,
  'horizontal-line': 1,
  'horizontal-ray': 1,
  'vertical-line': 1,
  'cross-line': 1,
};

/**
 * What each tool's settings offer (TradingView's settings dialog; which rows each tool shows is
 * provisional until measured from screenshots, §11).
 */
export interface ToolOptions {
  /** Extend left and right. */
  extend: boolean;
  /** Left and right end: plain or an arrow. */
  ends: boolean;
  /** A point in the line's middle. */
  middlePoint: boolean;
  /** The anchors' prices on the price scale, always (not only while selected). */
  priceLabels: boolean;
  /** Price range, percent change, bars, time, distance and angle. */
  stats: boolean;
  /** Its price on the price scale (horizontal lines). */
  showPrice: boolean;
  /** Its time on the time scale (vertical lines). */
  showTime: boolean;
  /** The Text tab. */
  text: boolean;
}

const TREND_OPTIONS: ToolOptions = {
  extend: true,
  ends: true,
  middlePoint: true,
  priceLabels: true,
  stats: true,
  showPrice: false,
  showTime: false,
  text: true,
};
const NO_OPTIONS: ToolOptions = {
  extend: false,
  ends: false,
  middlePoint: false,
  priceLabels: false,
  stats: false,
  showPrice: false,
  showTime: false,
  text: false,
};

export const TOOL_OPTIONS: Record<DrawingTool, ToolOptions> = {
  'trend-line': TREND_OPTIONS,
  ray: TREND_OPTIONS,
  'info-line': TREND_OPTIONS,
  'extended-line': TREND_OPTIONS,
  // Its only text is its angle, in the line's color (the third-party capture; provisional).
  'trend-angle': {
    ...TREND_OPTIONS,
    ends: false,
    middlePoint: false,
    priceLabels: false,
    text: false,
  },
  'horizontal-line': { ...NO_OPTIONS, showPrice: true, text: true },
  'horizontal-ray': { ...NO_OPTIONS, showPrice: true, text: true },
  'vertical-line': { ...NO_OPTIONS, showTime: true, text: true },
  'cross-line': { ...NO_OPTIONS, showPrice: true, showTime: true },
};

/** A drawing's anchor: a bar's time (UTC seconds) and a price, on its pane's scale. */
export interface DrawingPoint {
  time: number;
  price: number;
}

export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type DrawingLineStyle = (typeof LINE_STYLES)[number];

/** The thicknesses TradingView's line picker offers. */
export const LINE_WIDTHS = [1, 2, 3, 4] as const;

export const LINE_ENDS = ['normal', 'arrow'] as const;
export type LineEnd = (typeof LINE_ENDS)[number];

export const H_ALIGNS = ['left', 'center', 'right'] as const;
export const V_ALIGNS = ['top', 'middle', 'bottom'] as const;
export type HAlign = (typeof H_ALIGNS)[number];
export type VAlign = (typeof V_ALIGNS)[number];

/** The stats a line can show beside it (TradingView's Stats: Price range … Angle). */
export interface DrawingStats {
  priceRange: boolean;
  percentChange: boolean;
  pips: boolean;
  barsRange: boolean;
  dateTimeRange: boolean;
  distance: boolean;
  angle: boolean;
}

export interface DrawingText {
  value: string;
  color: string;
  /** Font size in px. */
  size: number;
  bold: boolean;
  italic: boolean;
  alignH: HAlign;
  alignV: VAlign;
}

export interface DrawingStyle {
  /** "#RRGGBB" or "#RRGGBBAA". */
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
  extendLeft: boolean;
  extendRight: boolean;
  leftEnd: LineEnd;
  rightEnd: LineEnd;
  showMiddlePoint: boolean;
  showPriceLabels: boolean;
  showPrice: boolean;
  showTime: boolean;
  stats: DrawingStats;
  /** Stats shown all the time, not only while the drawing is selected. */
  alwaysShowStats: boolean;
  statsPosition: HAlign;
  text: DrawingText;
}

/** TradingView's blue, its line tools' color (provisional, §11). */
export const DRAWING_BLUE = '#2962FF';

const NO_STATS: DrawingStats = {
  priceRange: false,
  percentChange: false,
  pips: false,
  barsRange: false,
  dateTimeRange: false,
  distance: false,
  angle: false,
};

const BASE_STYLE: DrawingStyle = {
  color: DRAWING_BLUE,
  width: 2,
  lineStyle: 'solid',
  extendLeft: false,
  extendRight: false,
  leftEnd: 'normal',
  rightEnd: 'normal',
  showMiddlePoint: false,
  showPriceLabels: false,
  showPrice: false,
  showTime: false,
  stats: NO_STATS,
  alwaysShowStats: false,
  statsPosition: 'right',
  text: {
    value: '',
    color: DRAWING_BLUE,
    size: 14,
    bold: false,
    italic: false,
    alignH: 'center',
    alignV: 'bottom',
  },
};

/** A style of one's own, nothing shared with the one it came from. */
export function copyStyle(style: DrawingStyle): DrawingStyle {
  return { ...style, stats: { ...style.stats }, text: { ...style.text } };
}

/** Each tool's style as TradingView starts it (provisional, §11). */
export function defaultDrawingStyle(tool: DrawingTool): DrawingStyle {
  const style = copyStyle(BASE_STYLE);
  switch (tool) {
    case 'ray':
      style.extendRight = true;
      break;
    case 'extended-line':
      style.extendLeft = true;
      style.extendRight = true;
      break;
    case 'info-line':
      style.stats = {
        priceRange: true,
        percentChange: true,
        pips: true,
        barsRange: true,
        dateTimeRange: true,
        distance: true,
        angle: true,
      };
      style.alwaysShowStats = true;
      style.statsPosition = 'center';
      break;
    case 'trend-angle':
      // The angle: 12 px bold (TradingView's old Charting Library defaults, linetooltrendangle).
      style.text.size = 12;
      style.text.bold = true;
      break;
    case 'horizontal-line':
    case 'horizontal-ray':
      style.showPrice = true;
      style.text.size = 12;
      style.text.alignV = 'top';
      break;
    case 'vertical-line':
      style.showTime = true;
      style.text.alignV = 'middle';
      break;
    case 'cross-line':
      style.showPrice = true;
      style.showTime = true;
      style.text.color = '#FFFFFF';
      break;
    default:
      break;
  }
  return style;
}

// ---- visibility on intervals ----

/** The Visibility tab's rows, as TradingView lists them. */
export const VISIBILITY_UNITS = [
  'ticks',
  'seconds',
  'minutes',
  'hours',
  'days',
  'weeks',
  'months',
  'ranges',
] as const;
export type VisibilityUnit = (typeof VISIBILITY_UNITS)[number];

/** Each row's range, or none where TradingView offers only the checkbox (ticks, ranges). */
export const VISIBILITY_LIMITS: Record<VisibilityUnit, readonly [number, number] | null> = {
  ticks: null,
  seconds: [1, 59],
  minutes: [1, 59],
  hours: [1, 24],
  days: [1, 366],
  weeks: [1, 52],
  months: [1, 12],
  ranges: null,
};

export interface VisibilityRow {
  on: boolean;
  from: number;
  to: number;
}
export type DrawingVisibility = Record<VisibilityUnit, VisibilityRow>;

/** Shown on every interval, as a new drawing is. */
export function defaultVisibility(): DrawingVisibility {
  const rows = {} as DrawingVisibility;
  for (const unit of VISIBILITY_UNITS) {
    const limits = VISIBILITY_LIMITS[unit];
    rows[unit] = { on: true, from: limits?.[0] ?? 1, to: limits?.[1] ?? 1 };
  }
  return rows;
}

/** The Visibility tab's row for an interval, and the interval's count in that row's unit. */
export function visibilityRowOf(resolution: Resolution): [VisibilityUnit, number] {
  switch (resolution.unit) {
    case 'tick':
      return ['ticks', resolution.count];
    case 'second':
      return ['seconds', resolution.count];
    case 'minute':
      // An hour or more is the Hours row, 90 minutes as 1.5 hours.
      return resolution.count >= 60
        ? ['hours', resolution.count / 60]
        : ['minutes', resolution.count];
    case 'day':
      return ['days', resolution.count];
    case 'week':
      return ['weeks', resolution.count];
    case 'month':
      return ['months', resolution.count];
  }
}

/** Whether a drawing shows on an interval (its Visibility tab). */
export function visibleOn(visibility: DrawingVisibility, resolution: Resolution): boolean {
  const [unit, count] = visibilityRowOf(resolution);
  const row = visibility[unit];
  if (!row.on) return false;
  const limits = VISIBILITY_LIMITS[unit];
  if (limits === null) return true;
  // An interval past the row's ends counts as its end: a full row shows on 2 years of days too.
  const within = Math.min(limits[1], Math.max(limits[0], count));
  return within >= row.from && within <= row.to;
}

// ---- drawings ----

export interface Drawing {
  /** Made by the app; letters, digits, "-" and "_". */
  id: string;
  tool: DrawingTool;
  points: DrawingPoint[];
  /** The pane it's drawn on: null for the price pane, else its indicator's id. */
  pane: string | null;
  style: DrawingStyle;
  visibility: DrawingVisibility;
  /** Can't be moved, edited or deleted with the Delete key until unlocked. */
  locked: boolean;
  hidden: boolean;
}

/** A new drawing with its tool's defaults. */
export function newDrawing(
  id: string,
  tool: DrawingTool,
  points: DrawingPoint[],
  pane: string | null = null,
): Drawing {
  return {
    id,
    tool,
    points: points.map((point) => ({ ...point })),
    pane,
    style: defaultDrawingStyle(tool),
    visibility: defaultVisibility(),
    locked: false,
    hidden: false,
  };
}

/** No limit to speak of: TradingView's Basic plan caps at 30 (third-party reports, 2026); this only guards the file. */
export const MAX_DRAWINGS_PER_SYMBOL = 5_000;
export const MAX_DRAWING_TEXT = 5_000;
export const MAX_DRAWING_SYMBOLS = 10_000;

/** Drawings belong to a symbol as the chart names it, case aside ("BINANCE:XRPUSDT"). */
export function drawingsKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const color = (value: unknown, fallback: string): string =>
  typeof value === 'string' && COLOR.test(value) ? value.toUpperCase() : fallback;

const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

const number = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

/**
 * A style as stored, each field checked and filled from the tool's defaults where it's missing
 * or wrong, so an older file reads in a newer app.
 */
export function parseDrawingStyle(value: unknown, tool: DrawingTool): DrawingStyle {
  const base = defaultDrawingStyle(tool);
  if (!isRecord(value)) return base;
  const stats = isRecord(value.stats) ? value.stats : {};
  const text = isRecord(value.text) ? value.text : {};
  return {
    color: color(value.color, base.color),
    width: (LINE_WIDTHS as readonly number[]).includes(value.width as number)
      ? (value.width as number)
      : base.width,
    lineStyle: oneOf(LINE_STYLES, value.lineStyle, base.lineStyle),
    extendLeft: bool(value.extendLeft, base.extendLeft),
    extendRight: bool(value.extendRight, base.extendRight),
    leftEnd: oneOf(LINE_ENDS, value.leftEnd, base.leftEnd),
    rightEnd: oneOf(LINE_ENDS, value.rightEnd, base.rightEnd),
    showMiddlePoint: bool(value.showMiddlePoint, base.showMiddlePoint),
    showPriceLabels: bool(value.showPriceLabels, base.showPriceLabels),
    showPrice: bool(value.showPrice, base.showPrice),
    showTime: bool(value.showTime, base.showTime),
    stats: {
      priceRange: bool(stats.priceRange, base.stats.priceRange),
      percentChange: bool(stats.percentChange, base.stats.percentChange),
      pips: bool(stats.pips, base.stats.pips),
      barsRange: bool(stats.barsRange, base.stats.barsRange),
      dateTimeRange: bool(stats.dateTimeRange, base.stats.dateTimeRange),
      distance: bool(stats.distance, base.stats.distance),
      angle: bool(stats.angle, base.stats.angle),
    },
    alwaysShowStats: bool(value.alwaysShowStats, base.alwaysShowStats),
    statsPosition: oneOf(H_ALIGNS, value.statsPosition, base.statsPosition),
    text: {
      value:
        typeof text.value === 'string' ? text.value.slice(0, MAX_DRAWING_TEXT) : base.text.value,
      color: color(text.color, base.text.color),
      size: Math.round(number(text.size, 6, 100, base.text.size)),
      bold: bool(text.bold, base.text.bold),
      italic: bool(text.italic, base.text.italic),
      alignH: oneOf(H_ALIGNS, text.alignH, base.text.alignH),
      alignV: oneOf(V_ALIGNS, text.alignV, base.text.alignV),
    },
  };
}

function parseVisibility(value: unknown): DrawingVisibility {
  const rows = defaultVisibility();
  if (!isRecord(value)) return rows;
  for (const unit of VISIBILITY_UNITS) {
    const row = value[unit];
    if (!isRecord(row)) continue;
    const limits = VISIBILITY_LIMITS[unit];
    const [min, max] = limits ?? [1, 1];
    const from = Math.round(number(row.from, min, max, rows[unit].from));
    const to = Math.round(number(row.to, min, max, rows[unit].to));
    rows[unit] = { on: bool(row.on, true), from: Math.min(from, to), to: Math.max(from, to) };
  }
  return rows;
}

/** A drawing as stored or sent, or null when it isn't one. */
export function parseDrawing(value: unknown): Drawing | null {
  if (!isRecord(value)) return null;
  const { id, tool, points, pane } = value;
  if (typeof id !== 'string' || !ID.test(id) || !isDrawingTool(tool)) return null;
  if (!Array.isArray(points) || points.length !== TOOL_POINTS[tool]) return null;
  const anchors: DrawingPoint[] = [];
  for (const point of points) {
    if (!isRecord(point)) return null;
    const { time, price } = point;
    if (typeof time !== 'number' || !Number.isFinite(time)) return null;
    if (typeof price !== 'number' || !Number.isFinite(price)) return null;
    anchors.push({ time, price });
  }
  if (pane !== null && (typeof pane !== 'string' || pane.length === 0 || pane.length > 64)) {
    return null;
  }
  return {
    id,
    tool,
    points: anchors,
    pane,
    style: parseDrawingStyle(value.style, tool),
    visibility: parseVisibility(value.visibility),
    locked: bool(value.locked, false),
    hidden: bool(value.hidden, false),
  };
}

/** One symbol's drawings, as the gateway serves and takes them. */
export interface SymbolDrawings {
  symbol: string;
  drawings: Drawing[];
}

export function parseSymbolDrawings(value: unknown): SymbolDrawings | null {
  if (!isRecord(value) || typeof value.symbol !== 'string') return null;
  const symbol = drawingsKey(value.symbol);
  if (symbol.length === 0 || symbol.length > 300 || !Array.isArray(value.drawings)) return null;
  if (value.drawings.length > MAX_DRAWINGS_PER_SYMBOL) return null;
  const drawings: Drawing[] = [];
  const ids = new Set<string>();
  for (const item of value.drawings) {
    const drawing = parseDrawing(item);
    if (!drawing || ids.has(drawing.id)) return null;
    ids.add(drawing.id);
    drawings.push(drawing);
  }
  return { symbol, drawings };
}

/** `data/drawings.json`: every symbol's drawings, in drawing order (the last on top). */
export interface DrawingsFile {
  version: 1;
  symbols: Record<string, Drawing[]>;
}

export function parseDrawingsFile(value: unknown): DrawingsFile | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.symbols)) return null;
  const entries = Object.entries(value.symbols);
  if (entries.length > MAX_DRAWING_SYMBOLS) return null;
  const symbols: Record<string, Drawing[]> = {};
  for (const [symbol, drawings] of entries) {
    const parsed = parseSymbolDrawings({ symbol, drawings });
    if (!parsed) return null;
    if (parsed.drawings.length > 0) symbols[parsed.symbol] = parsed.drawings;
  }
  return { version: 1, symbols };
}
