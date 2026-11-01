import type { MarkLook } from '@tradingnerd/indicators';
import type {
  IChartApi,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { DrawTarget } from './axisLabel';

/**
 * One of a script's mark plots (Pine docs, Text and shapes): plotshape's shapes, plotchar's
 * characters or plotarrow's arrows, each with its text, on the bars its series picks.
 */
export interface MarkSet {
  id: string;
  look: MarkLook;
  /** The value drawn at logical bar `i` (its offset applied): na or 0 for no mark. */
  valueAt(i: number): number;
  /** The mark's CSS color at bar `i`; null for none (Pine's na color hides the mark). */
  colorAt(i: number): string | null;
  /** Its text's CSS color at bar `i`; null for none. */
  textColorAt(i: number): string | null;
  /** The first and last bars it draws. */
  start: number;
  end: number;
}

/** The chart's own bars, which abovebar and belowbar marks and the arrows sit against. */
export interface BarExtent {
  high(i: number): number;
  low(i: number): number;
}

/**
 * Sizes, all provisional (docs/SPEC.md §11): TradingView doesn't document them, so they are
 * measured from the Pine manual's figures until a screenshot of the user's calibrates them.
 * size.auto follows the bar spacing: plotshape's arrows are 0.39 of it wide ("Lift text"
 * figure); plotarrow's heads 0.85 of it, their shafts 0.58 of the head and the head half as tall
 * as wide (Figures 288 and 289, measured 2026-11-01).
 */
const SHAPE_PX: Record<MarkLook['size'], number> = {
  auto: 0,
  tiny: 8,
  small: 12,
  normal: 16,
  large: 24,
  huge: 32,
};
/** A character's font size by size: a glyph fills less of its box than a shape does. */
const CHAR_PX: Record<MarkLook['size'], number> = {
  auto: 0,
  tiny: 10,
  small: 14,
  normal: 20,
  large: 28,
  huge: 40,
};
const AUTO_SHARE = 0.39;
const ARROW_HEAD_SHARE = 0.85;
const ARROW_SHAFT_SHARE = 0.58;
/** Between a bar's high or low (or the pane's edge) and its mark. */
const GAP = 4;
/** Between a mark and its text. */
const TEXT_GAP = 2;

/** A shape's box at size.auto: its share of the bar spacing, 6 to 32 px. */
export const autoSize = (barSpacing: number): number =>
  Math.min(32, Math.max(6, AUTO_SHARE * barSpacing));

/** The text's font size: it grows as the bars spread, as the manual's figures show it, 11 to 24 px. */
export const textSize = (barSpacing: number): number =>
  Math.min(24, Math.max(11, Math.round(0.38 * barSpacing)));

/** plotarrow's head width: its share of the bar spacing, 3 to 40 px. */
export const arrowWidth = (barSpacing: number): number =>
  Math.min(40, Math.max(3, ARROW_HEAD_SHARE * barSpacing));

/** One mark as laid out for drawing, in CSS px. */
export interface DrawnMark {
  id: string;
  kind: MarkLook['kind'];
  shape: string | null;
  char: string | null;
  x: number;
  /** The mark's center; an arrow's tip. */
  y: number;
  /** A shape's box or a character's font size; an arrow's head width. */
  size: number;
  color: string | null;
  text: string;
  textColor: string | null;
  font: number;
  /** Text above (−1) or below (1) the mark. */
  textSide: -1 | 1;
  /** An arrow's length, and which way it points (−1 up, 1 down). */
  length: number;
  direction: -1 | 1;
}

/**
 * Draws a script's marks over its pane, from a clear series that carries them on the pane's
 * scale: the prices they stand at are that series' points, so they count in its autoscale.
 */
export class MarksPrimitive implements ISeriesPrimitive<Time> {
  private readonly views: readonly IPrimitivePaneView[];
  private readonly family: string;
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private sets: readonly MarkSet[] = [];
  private bars: BarExtent | null = null;
  private drawn: DrawnMark[] = [];

  /** `font`: the chart's, e.g. "12px -apple-system, …"; its family writes the text. */
  constructor(font: string) {
    this.family = font.replace(/^\s*\d+(\.\d+)?px\s*/, '');
    this.views = [{ zOrder: () => 'top', renderer: () => ({ draw: (t) => this.draw(t) }) }];
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  update(sets: readonly MarkSet[], bars: BarExtent): void {
    this.sets = sets;
    this.bars = bars;
    this.requestUpdate?.();
  }

  /** The marks drawn last (for tests and diagnostics). */
  drawnMarks(): readonly DrawnMark[] {
    return this.drawn;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Lays the visible marks out in a pane `height` px tall. */
  layout(height: number): DrawnMark[] {
    const { chart, series, bars } = this;
    if (!chart || !series) return [];
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return [];
    const spacing = timeScale.options().barSpacing;
    const font = textSize(spacing);
    const priceY = (price: number | undefined): number | null =>
      price === undefined || !Number.isFinite(price) ? null : series.priceToCoordinate(price);
    const out: DrawnMark[] = [];
    for (const set of this.sets) {
      const { look } = set;
      const from = Math.max(set.start, Math.floor(range.from) - 1, 0);
      const to = Math.min(set.end, Math.ceil(range.to) + 1);
      // An arrow's length grows with its value against the largest one in view (provisional).
      let largest = 0;
      if (look.kind === 'arrow') {
        for (let i = from; i <= to; i++) {
          const v = Math.abs(set.valueAt(i));
          if (Number.isFinite(v) && v > largest) largest = v;
        }
      }
      for (let i = from; i <= to; i++) {
        const value = set.valueAt(i);
        if (!shows(look, value)) continue;
        const x = timeScale.logicalToCoordinate(i as Logical);
        if (x === null) continue;
        const color = set.colorAt(i);
        const textColor = set.textColorAt(i);
        const base = {
          id: set.id,
          kind: look.kind,
          shape: look.shape,
          char: look.char,
          x,
          color,
          text: look.text,
          textColor,
          font,
        };
        if (look.kind === 'arrow') {
          // Up from below the bar's low for a positive value, down from above its high else.
          const up = value > 0;
          const span = Math.max(0, look.maxheight - look.minheight);
          const length = look.minheight + (largest > 0 ? (span * Math.abs(value)) / largest : 0);
          const at = priceY(up ? bars?.low(i) : bars?.high(i));
          if (at === null) continue;
          out.push({
            ...base,
            text: '',
            y: up ? at + GAP : at - GAP,
            size: arrowWidth(spacing),
            textSide: up ? 1 : -1,
            length,
            direction: up ? -1 : 1,
          });
          continue;
        }
        const size =
          look.kind === 'char'
            ? CHAR_PX[look.size] || autoSize(spacing) * 1.4
            : SHAPE_PX[look.size] || autoSize(spacing);
        // plotshape's arrows are taller than wide (1.3 in the "Lift text" figure).
        const tall = look.shape === 'arrowup' || look.shape === 'arrowdown' ? 1.3 : 1;
        const half = (size * tall) / 2;
        let y: number | null;
        let textSide: -1 | 1 = -1;
        switch (look.location) {
          case 'top':
            y = GAP + half;
            textSide = 1;
            break;
          case 'bottom':
            y = height - GAP - half;
            break;
          case 'absolute':
            y = priceY(value);
            break;
          case 'belowbar': {
            const low = priceY(bars?.low(i));
            y = low === null ? null : low + GAP + half;
            textSide = 1;
            break;
          }
          default: {
            const high = priceY(bars?.high(i));
            y = high === null ? null : high - GAP - half;
          }
        }
        if (y === null) continue;
        out.push({ ...base, y, size, textSide, length: half * 2, direction: 1 });
      }
    }
    return out;
  }

  private draw(target: DrawTarget): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.drawn = this.layout(mediaSize.height);
      for (const mark of this.drawn) {
        const label = mark.shape === 'labelup' || mark.shape === 'labeldown';
        if (mark.color) {
          ctx.fillStyle = mark.color;
          ctx.strokeStyle = mark.color;
          if (mark.kind === 'arrow') drawArrow(ctx, mark);
          else if (mark.kind === 'char' && mark.char) {
            ctx.font = `${Math.round(mark.size)}px ${this.family}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(mark.char, mark.x, mark.y);
          } else if (label) drawLabel(ctx, mark, this.family);
          else if (mark.shape) drawShape(ctx, mark.shape, mark.x, mark.y, mark.size);
        }
        // A label holds its text; other marks write it beside them.
        if (mark.text && mark.textColor && !(label && mark.color)) drawText(ctx, mark, this.family);
      }
    });
  }
}

/** Whether a value draws a mark: any value at a price (absolute), else a true or non-zero one. */
function shows(look: MarkLook, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return (look.kind !== 'arrow' && look.location === 'absolute') || value !== 0;
}

/**
 * The text beside a mark, its lines stacked away from it: above a mark the last line is nearest,
 * below it the first, so "\n" lifts text up or pushes it down (Pine manual, Text and shapes).
 */
function drawText(ctx: CanvasRenderingContext2D, mark: DrawnMark, family: string): void {
  ctx.font = `${mark.font}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = mark.textSide < 0 ? 'bottom' : 'top';
  ctx.fillStyle = mark.textColor ?? '';
  const lines = mark.text.split('\n');
  const reach = mark.kind === 'char' ? mark.size / 2 : mark.length / 2;
  const line = mark.font + 2;
  lines.forEach((text, k) => {
    const offset =
      mark.textSide < 0
        ? -(reach + TEXT_GAP) - (lines.length - 1 - k) * line
        : reach + TEXT_GAP + k * line;
    ctx.fillText(text, mark.x, mark.y + offset);
  });
}

/**
 * plotarrow's arrow from its tip at (x, y): a head half as tall as wide, then a shaft to the
 * arrow's length; a short arrow is all head, flattened (Figures 288 and 289).
 */
export function arrowOutline(mark: DrawnMark): [number, number][] {
  const { x, y, length, direction, size } = mark;
  // Away from the tip: down for an up arrow (direction −1), up for a down arrow.
  const away = -direction;
  const head = Math.min(length, size / 2);
  const half = size / 2;
  const shaft = (size * ARROW_SHAFT_SHARE) / 2;
  const base = y + away * head;
  const tail = y + away * length;
  if (length <= head) {
    return [
      [x, y],
      [x + half, base],
      [x - half, base],
    ];
  }
  return [
    [x, y],
    [x + half, base],
    [x + shaft, base],
    [x + shaft, tail],
    [x - shaft, tail],
    [x - shaft, base],
    [x - half, base],
  ];
}

function drawArrow(ctx: CanvasRenderingContext2D, mark: DrawnMark): void {
  const points = arrowOutline(mark);
  ctx.beginPath();
  points.forEach(([px, py], k) => {
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
}

/** A label shape: a rounded box holding the text, its pointer toward the bar. */
function drawLabel(ctx: CanvasRenderingContext2D, mark: DrawnMark, family: string): void {
  const { x, y, size, font } = mark;
  const up = mark.shape === 'labelup';
  ctx.font = `${font}px ${family}`;
  const lines = (mark.text || '').split('\n');
  const textWidth = Math.max(0, ...lines.map((text) => ctx.measureText(text).width));
  const width = Math.max(size, textWidth + 12);
  const height = Math.max(size * 0.8, mark.text ? lines.length * (font + 2) + 6 : 0);
  const pointer = Math.max(3, size / 4);
  // labelup's pointer is its top, at the mark's top; labeldown's its bottom.
  const tip = up ? y - size / 2 : y + size / 2;
  const top = up ? tip + pointer : tip - pointer - height;
  ctx.beginPath();
  ctx.moveTo(x, tip);
  ctx.lineTo(x + pointer, up ? top : top + height);
  ctx.lineTo(x - pointer, up ? top : top + height);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x - width / 2, top, width, height, 2);
  ctx.fill();
  if (mark.text && mark.textColor) {
    ctx.fillStyle = mark.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((text, k) => {
      ctx.fillText(text, x, top + 3 + k * (font + 2));
    });
  }
}

/** plotshape's shapes, centered at (x, y) in a box `s` wide, after the manual's table of them. */
function drawShape(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, s: number) {
  const h = s / 2;
  ctx.lineWidth = Math.max(1, s / 8);
  ctx.beginPath();
  switch (shape) {
    case 'xcross':
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.moveTo(x + h, y - h);
      ctx.lineTo(x - h, y + h);
      ctx.stroke();
      return;
    case 'cross':
      ctx.moveTo(x - h, y);
      ctx.lineTo(x + h, y);
      ctx.moveTo(x, y - h);
      ctx.lineTo(x, y + h);
      ctx.stroke();
      return;
    case 'circle':
      ctx.arc(x, y, h, 0, Math.PI * 2);
      break;
    case 'square':
      ctx.rect(x - h, y - h, s, s);
      break;
    case 'diamond':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x - h, y);
      break;
    case 'triangleup':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.lineTo(x - h, y + h);
      break;
    case 'triangledown':
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y - h);
      ctx.lineTo(x, y + h);
      break;
    case 'arrowup':
    case 'arrowdown': {
      // 1.3 times as tall as wide: a head half its height, a shaft half its width.
      const t = h * 1.3;
      const d = shape === 'arrowup' ? 1 : -1;
      ctx.moveTo(x, y - d * t);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x + h / 2, y);
      ctx.lineTo(x + h / 2, y + d * t);
      ctx.lineTo(x - h / 2, y + d * t);
      ctx.lineTo(x - h / 2, y);
      ctx.lineTo(x - h, y);
      break;
    }
    case 'flag': {
      // A pole at the left, and a flag waving from its top.
      const pole = Math.max(1, s / 8);
      ctx.rect(x - h, y - h, pole, s);
      ctx.moveTo(x - h + pole, y - h);
      ctx.quadraticCurveTo(x - h / 4, y - h * 1.2, x + h / 4, y - h * 0.75);
      ctx.quadraticCurveTo(x + h * 0.7, y - h * 0.35, x + h, y - h * 0.7);
      ctx.lineTo(x + h, y + h * 0.1);
      ctx.quadraticCurveTo(x + h * 0.7, y + h * 0.45, x + h / 4, y + h * 0.05);
      ctx.quadraticCurveTo(x - h / 4, y - h * 0.4, x - h + pole, y - h * 0.1);
      break;
    }
    default:
      return;
  }
  ctx.closePath();
  ctx.fill();
}
