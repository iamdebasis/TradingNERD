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
 * PathLineToolOverrides). The channels' and pitchforks' (D2) are TradingView's own, from its
 * Charting Library docs' overrides for each tool (read 2026-11-25), but the parallel channel's
 * extra levels, which the docs don't list yet, from the same third-party capture. Provisional
 * until measured from the user's screenshots (§11).
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

/** The Channels section, under the Lines (the user's screenshot of 25 November; D2). */
export const CHANNEL_TOOLS = [
  'parallel-channel',
  'regression-trend',
  'flat-top-bottom',
  'disjoint-channel',
] as const;

/** The Pitchforks section, under the Channels (D2). */
export const PITCHFORK_TOOLS = [
  'pitchfork',
  'schiff-pitchfork',
  'modified-schiff-pitchfork',
  'inside-pitchfork',
] as const;

/** TradingView's trend line tools: its toolbar's first group, whose menu has these three sections. */
export const TREND_LINE_TOOLS = [...LINE_TOOLS, ...CHANNEL_TOOLS, ...PITCHFORK_TOOLS] as const;

/** Every tool a drawing can be made with (later milestones add shapes, text and measuring). */
export const DRAWING_TOOLS = TREND_LINE_TOOLS;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];
export type PitchforkTool = (typeof PITCHFORK_TOOLS)[number];

export function isDrawingTool(value: unknown): value is DrawingTool {
  return typeof value === 'string' && (DRAWING_TOOLS as readonly string[]).includes(value);
}

export function isPitchforkTool(value: unknown): value is PitchforkTool {
  return typeof value === 'string' && (PITCHFORK_TOOLS as readonly string[]).includes(value);
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
  'parallel-channel': 'Parallel channel',
  'regression-trend': 'Regression trend',
  'flat-top-bottom': 'Flat top/bottom',
  'disjoint-channel': 'Disjoint channel',
  pitchfork: 'Pitchfork',
  'schiff-pitchfork': 'Schiff pitchfork',
  'modified-schiff-pitchfork': 'Modified Schiff pitchfork',
  'inside-pitchfork': 'Inside pitchfork',
};

/**
 * A pitchfork's kinds, as TradingView's menu and Style tab name them ("Original", "Schiff",
 * "Modified Schiff", "Inside": its Help Center's GIF 43000484410, November 2024): one switches
 * into another.
 */
export const PITCHFORK_KIND_NAMES: Record<PitchforkTool, string> = {
  pitchfork: 'Original',
  'schiff-pitchfork': 'Schiff',
  'modified-schiff-pitchfork': 'Modified Schiff',
  'inside-pitchfork': 'Inside',
};

/**
 * How many points place each tool: one click, two, or three. A regression trend's two are bars
 * (its prices come from them); the channels' and pitchforks' third sets their width (TradingView's
 * Help Center for each tool; the third-party capture's point counts).
 */
export const TOOL_POINTS: Record<DrawingTool, 1 | 2 | 3> = {
  'trend-line': 2,
  ray: 2,
  'info-line': 2,
  'extended-line': 2,
  'trend-angle': 2,
  'horizontal-line': 1,
  'horizontal-ray': 1,
  'vertical-line': 1,
  'cross-line': 1,
  'parallel-channel': 3,
  'regression-trend': 2,
  'flat-top-bottom': 3,
  'disjoint-channel': 3,
  pitchfork: 3,
  'schiff-pitchfork': 3,
  'modified-schiff-pitchfork': 3,
  'inside-pitchfork': 3,
};

/**
 * What each tool's settings offer (TradingView's settings dialog; which rows each tool shows is
 * provisional until measured from screenshots, §11).
 */
export interface ToolOptions {
  /** Extend left and right, two checkboxes. */
  extend: boolean;
  /** Extend as one drop-down: none, left, right or both (Flat top/bottom, Disjoint channel). */
  extendMenu: boolean;
  /** Extend lines, one checkbox: a pitchfork's back from their start, a regression's right. */
  extendLines: boolean;
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
  /** The levels: a parallel channel's extra lines, a pitchfork's lines beside its median. */
  levels: boolean;
  /**
   * The Background row: a color of its own (the channels), an opacity over its lines' colors
   * (the pitchforks), or none (a regression's bands are always filled, in its lines' colors).
   */
  fill: 'none' | 'color' | 'opacity';
  /** The main line can be hidden: a pitchfork's Median, a regression's Base. */
  hideLine: boolean;
  /** A regression trend's Inputs tab and its Up and Down lines. */
  regression: boolean;
}

const NO_OPTIONS: ToolOptions = {
  extend: false,
  extendMenu: false,
  extendLines: false,
  ends: false,
  middlePoint: false,
  priceLabels: false,
  stats: false,
  showPrice: false,
  showTime: false,
  text: false,
  levels: false,
  fill: 'none',
  hideLine: false,
  regression: false,
};
const TREND_OPTIONS: ToolOptions = {
  ...NO_OPTIONS,
  extend: true,
  ends: true,
  middlePoint: true,
  priceLabels: true,
  stats: true,
  text: true,
};
/** Flat top/bottom and Disjoint channel: Line with its ends, Extend, Prices, Background, Text. */
const ANGLED_CHANNEL_OPTIONS: ToolOptions = {
  ...NO_OPTIONS,
  extendMenu: true,
  ends: true,
  priceLabels: true,
  text: true,
  fill: 'color',
};
/** The pitchforks: Median, Levels, Extend lines, Background (Help Center, each pitchfork). */
const PITCHFORK_OPTIONS: ToolOptions = {
  ...NO_OPTIONS,
  extendLines: true,
  levels: true,
  fill: 'opacity',
  hideLine: true,
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
  // Help Center, Parallel channel: its levels, Extend left and right line, Background; Text.
  'parallel-channel': { ...NO_OPTIONS, extend: true, text: true, levels: true, fill: 'color' },
  // Help Center, Regression trend: Inputs (deviations, source); Base, Up, Down, Extend lines,
  // Pearson's R. No Text tab and no Background row.
  'regression-trend': { ...NO_OPTIONS, extendLines: true, hideLine: true, regression: true },
  'flat-top-bottom': ANGLED_CHANNEL_OPTIONS,
  'disjoint-channel': ANGLED_CHANNEL_OPTIONS,
  pitchfork: PITCHFORK_OPTIONS,
  'schiff-pitchfork': PITCHFORK_OPTIONS,
  'modified-schiff-pitchfork': PITCHFORK_OPTIONS,
  'inside-pitchfork': PITCHFORK_OPTIONS,
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

/**
 * A level of a parallel channel or a pitchfork (TradingView's levels: on or off, a coefficient,
 * and a line of its own). A channel's level `coeff` sits that share of the way from its first
 * line to its second (0.5 its middle line); a pitchfork's that share of its half-width out from
 * the median on each side (1 the lines through its second and third points).
 */
export interface DrawingLevel {
  coeff: number;
  visible: boolean;
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
}

/** A line of its own look that can be hidden: a regression trend's Up and Down lines. */
export interface DrawingLine {
  visible: boolean;
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
}

/**
 * The background: shown or not, in a color with its opacity ("#RRGGBBAA"). A pitchfork's and a
 * regression trend's bands take their lines' colors, so only this opacity counts for them.
 */
export interface DrawingFill {
  on: boolean;
  color: string;
}

/** TradingView's price sources, as the indicators' Source inputs list them. */
export const PRICE_SOURCES = [
  'open',
  'high',
  'low',
  'close',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** A regression trend's inputs and its Up and Down lines (Help Center, Regression trend). */
export interface RegressionSettings {
  /** How many standard deviations its Up line sits above the base line. */
  upperDeviation: number;
  /** And its Down line: negative is below. */
  lowerDeviation: number;
  /** Off: the Up line reaches the highest high instead (provisional, §11). */
  useUpperDeviation: boolean;
  /** Off: the Down line reaches the lowest low instead. */
  useLowerDeviation: boolean;
  source: PriceSource;
  up: DrawingLine;
  down: DrawingLine;
  /** Pearson's correlation coefficient under the drawing. */
  showPearsons: boolean;
}

export interface DrawingStyle {
  /**
   * The main line's look, "#RRGGBB" or "#RRGGBBAA": a line tool's line, a channel's lines (a
   * parallel channel's first and second), a pitchfork's median, a regression trend's base line.
   */
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
  /** The main line shows (a pitchfork's Median and a regression's Base can be turned off). */
  lineVisible: boolean;
  extendLeft: boolean;
  extendRight: boolean;
  /** Extend lines: a pitchfork's back from their start, a regression trend's to the right. */
  extendLines: boolean;
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
  /** A tool's levels, as many as TradingView's (none for the line tools). */
  levels: DrawingLevel[];
  fill: DrawingFill;
  regression: RegressionSettings;
}

/** TradingView's blue, its line tools' color (provisional, §11). */
export const DRAWING_BLUE = '#2962FF';
/** TradingView's red: a pitchfork's median and a regression trend's base line. */
export const DRAWING_RED = '#F23645';

const NO_STATS: DrawingStats = {
  priceRange: false,
  percentChange: false,
  pips: false,
  barsRange: false,
  dateTimeRange: false,
  distance: false,
  angle: false,
};

/**
 * A parallel channel's levels beside its two lines (coefficients 0 and 1), off but its dashed
 * middle line: TradingView added them in October 2024 (blog, Parallel channel gets more levels);
 * their coefficients and looks are the third-party capture's, the middle line TradingView's own
 * (Charting Library docs: showMidline, 1 px, dashed). Provisional (§11).
 */
export const PARALLEL_CHANNEL_LEVELS: readonly DrawingLevel[] = [
  { coeff: -0.25, visible: false, color: DRAWING_BLUE, width: 1, lineStyle: 'solid' },
  { coeff: 0.25, visible: false, color: DRAWING_BLUE, width: 1, lineStyle: 'solid' },
  { coeff: 0.5, visible: true, color: DRAWING_BLUE, width: 1, lineStyle: 'dashed' },
  { coeff: 0.75, visible: false, color: DRAWING_BLUE, width: 1, lineStyle: 'solid' },
  { coeff: 1.25, visible: false, color: DRAWING_BLUE, width: 1, lineStyle: 'solid' },
];

/**
 * A pitchfork's nine levels (Charting Library docs, PitchforkLineToolOverrides): 0.5 and 1 on,
 * TradingView's "two additional sets of lines" (Help Center, Pitchfork), the rest off.
 */
export const PITCHFORK_LEVELS: readonly DrawingLevel[] = [
  { coeff: 0.25, visible: false, color: '#FFB74D', width: 2, lineStyle: 'solid' },
  { coeff: 0.382, visible: false, color: '#81C784', width: 2, lineStyle: 'solid' },
  { coeff: 0.5, visible: true, color: '#089981', width: 2, lineStyle: 'solid' },
  { coeff: 0.618, visible: false, color: '#089981', width: 2, lineStyle: 'solid' },
  { coeff: 0.75, visible: false, color: '#00BCD4', width: 2, lineStyle: 'solid' },
  { coeff: 1, visible: true, color: DRAWING_BLUE, width: 2, lineStyle: 'solid' },
  { coeff: 1.5, visible: false, color: '#9C27B0', width: 2, lineStyle: 'solid' },
  { coeff: 1.75, visible: false, color: '#E91E63', width: 2, lineStyle: 'solid' },
  { coeff: 2, visible: false, color: '#F77C80', width: 2, lineStyle: 'solid' },
];

/** A level's coefficient stays within this, either way. */
export const MAX_LEVEL_COEFF = 100;
/** A regression's deviations stay within this, either way. */
export const MAX_DEVIATION = 100;

/** Charting Library docs, RegressiontrendLineToolOverrides: ±2 deviations of the closes. */
const DEFAULT_REGRESSION: RegressionSettings = {
  upperDeviation: 2,
  lowerDeviation: -2,
  useUpperDeviation: true,
  useLowerDeviation: true,
  source: 'close',
  up: { visible: true, color: DRAWING_BLUE, width: 2, lineStyle: 'solid' },
  down: { visible: true, color: DRAWING_BLUE, width: 2, lineStyle: 'solid' },
  showPearsons: true,
};

const BASE_STYLE: DrawingStyle = {
  color: DRAWING_BLUE,
  width: 2,
  lineStyle: 'solid',
  lineVisible: true,
  extendLeft: false,
  extendRight: false,
  extendLines: false,
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
  levels: [],
  fill: { on: false, color: '#2962FF33' },
  regression: DEFAULT_REGRESSION,
};

/** A style of one's own, nothing shared with the one it came from. */
export function copyStyle(style: DrawingStyle): DrawingStyle {
  return {
    ...style,
    stats: { ...style.stats },
    text: { ...style.text },
    levels: style.levels.map((level) => ({ ...level })),
    fill: { ...style.fill },
    regression: {
      ...style.regression,
      up: { ...style.regression.up },
      down: { ...style.regression.down },
    },
  };
}

/** Each tool's style as TradingView starts it (provisional, §11). */
export function defaultDrawingStyle(tool: DrawingTool): DrawingStyle {
  const style = copyStyle(BASE_STYLE);
  // The channels' text starts at their left, under them (Charting Library docs: labelHorzAlign
  // left, labelVertAlign bottom), in their color.
  const channelText = (color: string) => {
    style.text.alignH = 'left';
    style.text.alignV = 'bottom';
    style.text.color = color;
  };
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
    // The channels and pitchforks: TradingView's own defaults (Charting Library docs, each
    // tool's overrides, read 2026-11-25).
    case 'parallel-channel':
      style.fill = { on: true, color: '#2962FF33' };
      style.levels = PARALLEL_CHANNEL_LEVELS.map((level) => ({ ...level }));
      channelText(DRAWING_BLUE);
      break;
    case 'regression-trend':
      // The base line red, 1 px, dashed; the bands filled in their lines' colors at 30%
      // (transparency 70).
      style.color = DRAWING_RED;
      style.width = 1;
      style.lineStyle = 'dashed';
      style.fill = { on: true, color: '#0000004D' };
      break;
    case 'flat-top-bottom':
      style.color = '#FF9800';
      style.fill = { on: true, color: '#FF980033' };
      channelText('#FF9800');
      break;
    case 'disjoint-channel':
      style.color = '#089981';
      style.fill = { on: true, color: '#08998133' };
      channelText('#089981');
      break;
    case 'pitchfork':
    case 'schiff-pitchfork':
    case 'modified-schiff-pitchfork':
    case 'inside-pitchfork':
      // The median red at 2 px; each band between levels in its level's color at 20%
      // (transparency 80).
      style.color = DRAWING_RED;
      style.fill = { on: true, color: '#00000033' };
      style.levels = PITCHFORK_LEVELS.map((level) => ({ ...level }));
      break;
    default:
      break;
  }
  return style;
}

/** A fill's color with another color's hue, its own opacity kept. */
function hueOf(color: string, fill: string): string {
  return color.slice(0, 7).toUpperCase() + fill.slice(7);
}

/**
 * The drawing in one color, as the floating toolbar's Line color sets it: every line of it (its
 * main line, its levels, a regression's Up and Down) and a channel's background, which keeps its
 * opacity; its text keeps its own color (ours: TradingView's toolbar for these tools isn't
 * measured yet, provisional §11).
 */
export function recolorDrawing(drawing: Drawing, color: string): Drawing {
  const options = TOOL_OPTIONS[drawing.tool];
  const style = copyStyle(drawing.style);
  style.color = color;
  if (options.levels) for (const level of style.levels) level.color = color;
  if (options.regression) {
    style.regression.up.color = color;
    style.regression.down.color = color;
  }
  if (options.fill === 'color') style.fill.color = hueOf(color, style.fill.color);
  return { ...drawing, style };
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

/**
 * The quick choices of a drawing's "Visibility on intervals" menu ("Intervals visibility" before
 * 2024; Help Center, How to quickly adjust visibility of a drawing or indicator; blog, Faster
 * setup of visibility on intervals), each setting its Visibility tab from the chart's interval.
 * TradingView's Charting Library names the four (Chart.Source.IntervalsVisibility:
 * CurrentAndAbove, CurrentAndBelow, Current, All); their words and order are provisional until
 * measured from a screenshot (docs/SPEC.md §11).
 */
export const INTERVAL_PRESETS = [
  'current-and-above',
  'current-and-below',
  'current-only',
  'all',
] as const;
export type IntervalPreset = (typeof INTERVAL_PRESETS)[number];

export const INTERVAL_PRESET_NAMES: Record<IntervalPreset, string> = {
  'current-and-above': 'Current interval and above',
  'current-and-below': 'Current interval and below',
  'current-only': 'Current interval only',
  all: 'All intervals',
};

/** The Visibility tab's time rows, shortest first (Ranges isn't a time: the presets leave it). */
const TIME_UNITS: readonly VisibilityUnit[] = [
  'ticks',
  'seconds',
  'minutes',
  'hours',
  'days',
  'weeks',
  'months',
];

/**
 * A drawing's Visibility tab after one of the quick choices, on the chart's interval: the rows of
 * shorter units off for "and above" (longer ones on, whole), the interval's own row from it to the
 * row's end; "and below" the other way; "only" its own row at the interval alone. An interval
 * that isn't a whole count of its row (90 minutes, 1.5 hours) keeps the counts around it. "All
 * intervals" shows it everywhere. Ranges stays as it was, but for "All intervals".
 */
export function intervalVisibility(
  preset: IntervalPreset,
  resolution: Resolution,
  current: DrawingVisibility,
): DrawingVisibility {
  const rows = defaultVisibility();
  if (preset === 'all') return rows;
  rows.ranges = { ...current.ranges };
  const [unit, count] = visibilityRowOf(resolution);
  const at = TIME_UNITS.indexOf(unit);
  const limits = VISIBILITY_LIMITS[unit];
  for (const [i, other] of TIME_UNITS.entries()) {
    if (i === at) continue;
    const shown =
      preset === 'current-and-above' ? i > at : preset === 'current-and-below' ? i < at : false;
    rows[other] = { ...rows[other], on: shown };
  }
  if (limits) {
    const [min, max] = limits;
    const low = Math.min(max, Math.max(min, Math.floor(count)));
    const high = Math.min(max, Math.max(min, Math.ceil(count)));
    rows[unit] = {
      on: true,
      from: preset === 'current-and-below' ? min : low,
      to: preset === 'current-and-above' ? max : high,
    };
  }
  return rows;
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
  /**
   * Drawn under the chart's bars (and an indicator pane's plots), where Visual order's "Send to
   * back" leaves it: TradingView's visual order takes in its candles (Help Center, How can I
   * change the visual order/layer of indicators, drawings & candles?); how exactly is
   * provisional (docs/SPEC.md §11). Protocol 15; false for a new drawing and an older file's.
   */
  below: boolean;
  /**
   * Its own name, given in the Object tree ("Rename") or its settings' title; empty for its
   * tool's name (TradingView's blog, Name your drawings; docs/SPEC.md §5.27, D3c). Protocol 17.
   */
  name: string;
  /**
   * The groups it's in, the outermost first (TradingView's groups of drawings, nested since
   * October 2026: its Help Center, How to create nested groups of drawings?; docs/SPEC.md §5.27,
   * D3c2). A group is the drawings that name it and has no record of its own, so an empty group
   * can't exist, as TradingView's rule says ("Empty groups are automatically removed"). Protocol
   * 18; none for a new drawing and an older file's.
   */
  groups: DrawingGroup[];
}

/** A group of drawings, as each drawing in it names it: the same id and name on each. */
export interface DrawingGroup {
  /** Made by the app, as a drawing's id. */
  id: string;
  /** "Group 1" when made; renamed as a drawing is (empty only in a file written by hand). */
  name: string;
}

/** Groups nest without a limit on TradingView (its Help Center); this only guards the file. */
export const MAX_GROUP_DEPTH = 32;

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
    below: false,
    name: '',
    groups: [],
  };
}

let idCount = 0;

/**
 * A new drawing's id: the time and a count keep it apart from every other made in this page, a
 * random part from those made in another tab at the same moment. Letters and digits only.
 */
export function newDrawingId(): string {
  const random = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `d${Date.now().toString(36)}${(idCount++).toString(36)}${random}`;
}

/** No limit to speak of: TradingView's Basic plan caps at 30 (third-party reports, 2026); this only guards the file. */
export const MAX_DRAWINGS_PER_SYMBOL = 5_000;
export const MAX_DRAWING_TEXT = 5_000;
/** A drawing's name, at most this long (ours: TradingView doesn't say; provisional, §11). */
export const MAX_DRAWING_NAME = 64;

/** A name as kept: each run of spaces one space, trimmed, at most MAX_DRAWING_NAME long. */
export function drawingName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DRAWING_NAME).trim();
}

/** What the Object tree and the settings' title call a drawing: its name, else its tool's. */
export function displayName(drawing: Pick<Drawing, 'name' | 'tool'>): string {
  return drawing.name || TOOL_NAMES[drawing.tool];
}
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

const lineWidth = (value: unknown, fallback: number): number =>
  (LINE_WIDTHS as readonly number[]).includes(value as number) ? (value as number) : fallback;

function parseLine(value: unknown, base: DrawingLine): DrawingLine {
  if (!isRecord(value)) return { ...base };
  return {
    visible: bool(value.visible, base.visible),
    color: color(value.color, base.color),
    width: lineWidth(value.width, base.width),
    lineStyle: oneOf(LINE_STYLES, value.lineStyle, base.lineStyle),
  };
}

/** A tool's levels: always its own count of them, each read over its default. */
function parseLevels(value: unknown, base: readonly DrawingLevel[]): DrawingLevel[] {
  const stored = Array.isArray(value) ? value : [];
  return base.map((level, i) => {
    const item: unknown = stored[i];
    if (!isRecord(item)) return { ...level };
    return {
      coeff: number(item.coeff, -MAX_LEVEL_COEFF, MAX_LEVEL_COEFF, level.coeff),
      visible: bool(item.visible, level.visible),
      color: color(item.color, level.color),
      width: lineWidth(item.width, level.width),
      lineStyle: oneOf(LINE_STYLES, item.lineStyle, level.lineStyle),
    };
  });
}

function parseRegression(value: unknown, base: RegressionSettings): RegressionSettings {
  const stored = isRecord(value) ? value : {};
  return {
    upperDeviation: number(
      stored.upperDeviation,
      -MAX_DEVIATION,
      MAX_DEVIATION,
      base.upperDeviation,
    ),
    lowerDeviation: number(
      stored.lowerDeviation,
      -MAX_DEVIATION,
      MAX_DEVIATION,
      base.lowerDeviation,
    ),
    useUpperDeviation: bool(stored.useUpperDeviation, base.useUpperDeviation),
    useLowerDeviation: bool(stored.useLowerDeviation, base.useLowerDeviation),
    source: oneOf(PRICE_SOURCES, stored.source, base.source),
    up: parseLine(stored.up, base.up),
    down: parseLine(stored.down, base.down),
    showPearsons: bool(stored.showPearsons, base.showPearsons),
  };
}

/**
 * A style as stored, each field checked and filled from the tool's defaults where it's missing
 * or wrong, so an older file reads in a newer app (a D1 drawing takes D2's fields' defaults).
 */
export function parseDrawingStyle(value: unknown, tool: DrawingTool): DrawingStyle {
  const base = defaultDrawingStyle(tool);
  if (!isRecord(value)) return base;
  const stats = isRecord(value.stats) ? value.stats : {};
  const text = isRecord(value.text) ? value.text : {};
  const fill = isRecord(value.fill) ? value.fill : {};
  return {
    color: color(value.color, base.color),
    width: lineWidth(value.width, base.width),
    lineStyle: oneOf(LINE_STYLES, value.lineStyle, base.lineStyle),
    lineVisible: bool(value.lineVisible, base.lineVisible),
    extendLeft: bool(value.extendLeft, base.extendLeft),
    extendRight: bool(value.extendRight, base.extendRight),
    extendLines: bool(value.extendLines, base.extendLines),
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
    levels: parseLevels(value.levels, base.levels),
    fill: { on: bool(fill.on, base.fill.on), color: color(fill.color, base.fill.color) },
    regression: parseRegression(value.regression, base.regression),
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
    below: bool(value.below, false),
    name: typeof value.name === 'string' ? drawingName(value.name) : '',
    groups: parseGroups(value.groups),
  };
}

/**
 * A drawing's groups as stored: none when the list isn't one (a group without a valid id, the
 * same group twice, deeper than MAX_GROUP_DEPTH), so the drawing itself still reads.
 */
function parseGroups(value: unknown): DrawingGroup[] {
  if (!Array.isArray(value) || value.length > MAX_GROUP_DEPTH) return [];
  const groups: DrawingGroup[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !ID.test(item.id)) return [];
    if (ids.has(item.id)) return [];
    ids.add(item.id);
    groups.push({ id: item.id, name: typeof item.name === 'string' ? drawingName(item.name) : '' });
  }
  return groups;
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
