import type { StrategyFill } from '@tradingnerd/pine';
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
import type { BarExtent } from './MarksPrimitive';

/**
 * A strategy's fills on the price pane, as TradingView marks them (the Pine manual's figures of
 * Orders and trades and Order types: Figures 231 and 232): a buy is an arrow up under the bar
 * with the order's name and "+qty" below it, a sell an arrow down over the bar with "−qty" and
 * the name above it; entries are blue (long) or red (short), exits purple, an exit's arrow
 * ending in a bar. A small triangle marks the fill's price beside the candle: on its left for an
 * entry, on its right for an exit. The colors are measured from those light-theme figures and the
 * sizes from their proportions: provisional (docs/SPEC.md §11), to be measured from screenshots.
 */

export const TRADE_COLORS = { long: '#1888E8', short: '#F85050', exit: '#C010D8' } as const;

/** Between the bar and its arrow, the arrow's length and head, the text's size and leading. */
const GAP = 6;
const ARROW = 14;
const HEAD = 4;
const FONT = 11;
const LEADING = 13;
const TRIANGLE = 4;

export class TradesPrimitive implements ISeriesPrimitive<Time> {
  private readonly views: readonly IPrimitivePaneView[];
  private readonly family: string;
  private readonly textColor: string;
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private fills: readonly StrategyFill[] = [];
  private bars: BarExtent | null = null;
  private painted = 0;

  constructor(font: string, textColor: string) {
    this.family = font.replace(/^\s*\d+(\.\d+)?px\s*/, '');
    this.textColor = textColor;
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

  update(fills: readonly StrategyFill[], bars: BarExtent): void {
    this.fills = fills;
    this.bars = bars;
    this.requestUpdate?.();
  }

  /** How many fills the last frame drew (for tests and diagnostics). */
  paintedCount(): number {
    return this.painted;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: DrawTarget): void {
    const { chart, series, bars } = this;
    if (!chart || !series || !bars) return;
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    this.painted = 0;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      ctx.font = `${FONT}px ${this.family}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Several fills on one bar stack away from it, in the order they filled.
      const above = new Map<number, number>();
      const below = new Map<number, number>();
      const spacing = Math.max(1, scale.options().barSpacing);
      for (const fill of this.fills) {
        if (range && (fill.bar < range.from - 1 || fill.bar > range.to + 1)) continue;
        const x = scale.logicalToCoordinate(fill.bar as Logical);
        if (x === null) continue;
        const buy = fill.qty > 0;
        const color = fill.entry
          ? buy
            ? TRADE_COLORS.long
            : TRADE_COLORS.short
          : TRADE_COLORS.exit;
        const edge = series.priceToCoordinate(buy ? bars.low(fill.bar) : bars.high(fill.bar));
        if (edge === null) continue;
        const stack = buy ? below : above;
        const depth = stack.get(fill.bar) ?? 0;
        const step = ARROW + 2 * LEADING + GAP;
        stack.set(fill.bar, depth + 1);
        const dir = buy ? 1 : -1;
        const start = edge + dir * (GAP + depth * step);
        this.arrow(ctx, x, start, dir, color, !fill.entry);
        const name = fill.name;
        const qty = `${buy ? '+' : '−'}${formatQty(Math.abs(fill.qty))}`;
        ctx.fillStyle = this.textColor;
        const textStart = start + dir * (ARROW + LEADING / 2 + 2);
        // Below a buy: the name, then the size; above a sell: the size on top, then the name.
        ctx.fillText(name, x, textStart);
        ctx.fillText(qty, x, textStart + dir * LEADING);
        // The fill's price beside the candle.
        const y = series.priceToCoordinate(fill.price);
        if (y !== null)
          this.triangle(ctx, fill.entry ? x - spacing / 2 : x + spacing / 2, y, fill.entry, color);
        this.painted++;
      }
      ctx.restore();
    });
  }

  /** An arrow from `y` pointing toward the bar (`dir` 1: up, under it; −1: down, over it). */
  private arrow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    dir: 1 | -1,
    color: string,
    exit: boolean,
  ): void {
    const tip = y;
    const tail = y + dir * ARROW;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, tail);
    ctx.lineTo(x, tip + dir * HEAD);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, tip);
    ctx.lineTo(x - HEAD, tip + dir * (HEAD + 1));
    ctx.lineTo(x + HEAD, tip + dir * (HEAD + 1));
    ctx.closePath();
    ctx.fill();
    if (exit) {
      // An exit's arrow ends in a bar at its tip.
      ctx.fillRect(x - HEAD, tip - (dir > 0 ? 2 : 0), 2 * HEAD, 2);
    }
  }

  /** A small triangle at the fill's price: pointing right for an entry, left for an exit. */
  private triangle(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    entry: boolean,
    color: string,
  ): void {
    const d = entry ? 1 : -1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - d * TRIANGLE, y - TRIANGLE);
    ctx.lineTo(x - d * TRIANGLE, y + TRIANGLE);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * A fill's size as the markers write it: whole units plainly; fractions to 2 decimals from a
 * thousand units, 4 from one, 8 below (provisional: TradingView's rounding isn't documented).
 */
export function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return String(qty);
  const digits = qty >= 1000 ? 2 : qty >= 1 ? 4 : 8;
  return String(Number(qty.toFixed(digits)));
}
