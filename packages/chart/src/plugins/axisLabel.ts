import type { IPrimitivePaneRenderer } from 'lightweight-charts';

/** The canvas target Lightweight Charts hands to plugin renderers. */
export type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

/**
 * Price-axis label geometry in CSS px, measured from TradingView
 * (docs/reference/01-chart-layout.png): labels are compact boxes sized to their text, starting
 * just inside the axis, not full-width bars.
 */
export const AXIS_LABEL = {
  /** Gap between the pane/axis boundary and the label. */
  left: 1,
  /** Text inset from the label's left edge and the space after the (zeroed) text: 9 / 5. */
  paddingLeft: 9,
  paddingRight: 5,
  radius: 3,
  /** Height of a one-line label (the crosshair price). */
  rowHeight: 21,
  /** Two-line label (last price + countdown): the price row is centered on the price level. */
  firstRowHeight: 16,
  secondRowHeight: 15,
  /** Space always left free on the far side of the axis. */
  minRightMargin: 2,
} as const;

/** TradingView's price axis is 72 px wide for prices like 1.2955. */
export const PRICE_AXIS_MIN_WIDTH = 72;

/** Half the height of a 12 px tick label, with room for antialiasing. */
const TICK_HALF_HEIGHT = 6;

export interface AxisLabelStyle {
  background: string;
  color: string;
  font: string;
  /** Corner radii: top-left, top-right, bottom-right, bottom-left. */
  radii?: [number, number, number, number];
}

/** What price-axis labels need to know about the axis they're drawn on. */
export interface AxisContext {
  /** Pane y of every tick label currently on the price axis. */
  tickYs(): readonly number[];
  /** Price-axis background color. */
  background: string;
}

/** Hides tick labels that a label would only partly cover, as TradingView does. */
export interface TickMask {
  /** Pane y of every tick label on the axis. */
  tickYs: readonly number[];
  /** Axis background, painted over colliding tick labels. */
  background: string;
  /** Axis width in CSS px. */
  axisWidth: number;
}

/**
 * Width a label needs for these rows of text. Like TradingView, it's measured with every digit
 * as 0, so a label keeps its width while the crosshair moves or the countdown ticks.
 */
export function axisLabelWidth(
  ctx: CanvasRenderingContext2D,
  rows: readonly string[],
  font: string,
) {
  ctx.font = font;
  const text = Math.max(...rows.map((row) => ctx.measureText(row.replace(/\d/g, '0')).width));
  return Math.ceil(text) + AXIS_LABEL.paddingLeft + AXIS_LABEL.paddingRight;
}

/** Rounds a media coordinate to the nearest device pixel of the context's current scale. */
export function snapToDevicePixel(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}

/** Vertical extent of a label whose first row is centered on `y`. */
export function axisLabelBox(y: number, rowCount: number): { top: number; heights: number[] } {
  const heights =
    rowCount > 1 ? [AXIS_LABEL.firstRowHeight, AXIS_LABEL.secondRowHeight] : [AXIS_LABEL.rowHeight];
  return { top: y - (heights[0] ?? AXIS_LABEL.rowHeight) / 2, heights };
}

/**
 * Draws a one- or two-row price-axis label whose first row is centered on `y` (media px).
 * Tick labels that collide with it are erased first, so none peeks out from behind it.
 */
export function drawAxisLabel(
  ctx: CanvasRenderingContext2D,
  y: number,
  rows: readonly string[],
  style: AxisLabelStyle,
  mask?: TickMask,
): void {
  const width = axisLabelWidth(ctx, rows, style.font);
  const { top, heights } = axisLabelBox(y, rows.length);
  const height = heights.reduce((sum, h) => sum + h, 0);

  if (mask) {
    ctx.fillStyle = mask.background;
    for (const tickY of mask.tickYs) {
      const collides = tickY + TICK_HALF_HEIGHT > top && tickY - TICK_HALF_HEIGHT < top + height;
      if (collides) {
        ctx.fillRect(0, tickY - TICK_HALF_HEIGHT, mask.axisWidth, 2 * TICK_HALF_HEIGHT);
      }
    }
  }

  // Edges on whole device pixels, so the box is as crisp as TradingView's (no blurred rows).
  const { a: scaleX, d: scaleY } = ctx.getTransform();
  const x0 = snapToDevicePixel(AXIS_LABEL.left, scaleX);
  const x1 = snapToDevicePixel(AXIS_LABEL.left + width, scaleX);
  const y0 = snapToDevicePixel(top, scaleY);
  const y1 = snapToDevicePixel(top + height, scaleY);
  ctx.fillStyle = style.background;
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, style.radii ?? AXIS_LABEL.radius);
  ctx.fill();

  ctx.fillStyle = style.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let rowTop = top;
  rows.forEach((row, i) => {
    const rowHeight = heights[i] ?? AXIS_LABEL.rowHeight;
    ctx.fillText(row, AXIS_LABEL.left + AXIS_LABEL.paddingLeft, rowTop + rowHeight / 2);
    rowTop += rowHeight;
  });
}
