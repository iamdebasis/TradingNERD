import type {
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import {
  AXIS_LABEL,
  type AxisContext,
  type DrawTarget,
  drawAxisLabel,
  snapToDevicePixel,
} from './axisLabel';

export interface ExtendedPriceState {
  price: number;
  /** Formatted price, e.g. "339.72". */
  text: string;
  /** "Pre" or "Post". */
  tag: string;
  /** Line, tag and label color. */
  color: string;
}

/** Dot and gap of the line, in CSS px: TradingView's, as the last price's. */
const DOT = 1;
const GAP = 3;
/**
 * The tag beside the price label, measured from a TradingView screenshot at 2× (docs/SPEC.md
 * §5.7): "Pre" in a 27 × 17 px box against the price axis, its outer corners rounded.
 */
export const TAG = { paddingLeft: 5, paddingRight: 4, height: 17, radius: 1.5 } as const;

/** A label's vertical extent on the price axis, pane y. */
export interface LabelBox {
  top: number;
  bottom: number;
}

/**
 * Where a label centered on `y` goes so it doesn't cover `other` (TradingView's "no
 * overlapping labels"): where it is, or right above or below the other label, on the side
 * its price is.
 */
export function labelClearOf(y: number, above: boolean, other: LabelBox | null): number {
  const half = TAG.height / 2;
  if (!other || y + half <= other.top || y - half >= other.bottom) return y;
  return above ? other.top - half : other.bottom + half;
}

/**
 * TradingView's pre/post-market price line: while a chart shows the regular session, the
 * latest pre- or post-market price as a dotted line across the pane, a "Pre"/"Post" tag at the
 * pane's right edge and the price on the axis, all in the session's color. Its label steps
 * clear of the last price's (provisional, docs/SPEC.md §11); the line stays at its price.
 */
export class ExtendedPricePrimitive implements ISeriesPrimitive<Time> {
  private readonly font: string;
  private readonly textColor: string;
  private readonly axisContext: AxisContext;
  private readonly lastPriceLabel: () => (LabelBox & { price: number }) | null;
  private readonly pane: readonly IPrimitivePaneView[];
  private readonly axis: readonly IPrimitivePaneView[];
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private state: ExtendedPriceState | null = null;
  /** The line's y, and its label's (moved clear of the last price's when they'd overlap). */
  private y: number | null = null;
  private labelY: number | null = null;

  /** `lastPriceLabel`: where the last price's label is, to keep clear of. */
  constructor(
    font: string,
    textColor: string,
    axisContext: AxisContext,
    lastPriceLabel: () => (LabelBox & { price: number }) | null = () => null,
  ) {
    this.font = font;
    this.textColor = textColor;
    this.axisContext = axisContext;
    this.lastPriceLabel = lastPriceLabel;
    this.pane = [{ zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.drawPane(t) }) }];
    this.axis = [{ zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.drawLabel(t) }) }];
  }

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  update(state: ExtendedPriceState | null): void {
    this.state = state;
    this.requestUpdate?.();
  }

  current(): ExtendedPriceState | null {
    return this.state;
  }

  updateAllViews(): void {
    this.y = this.state && this.series ? this.series.priceToCoordinate(this.state.price) : null;
    const last = this.lastPriceLabel();
    this.labelY =
      this.y === null || !this.state
        ? null
        : labelClearOf(this.y, this.state.price >= (last?.price ?? 0), last);
  }

  /** Where the label is drawn now (pane y), for tests. */
  currentLabelY(): number | null {
    return this.labelY;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.pane;
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.axis;
  }

  private drawPane(target: DrawTarget): void {
    const { state, y, labelY } = this;
    if (!state || y === null || labelY === null) return;
    target.useBitmapCoordinateSpace(
      ({ context: ctx, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
        const thickness = Math.max(1, Math.floor(verticalPixelRatio));
        const top = Math.round(y * verticalPixelRatio) - Math.floor(thickness / 2);
        const dot = Math.max(1, Math.round(DOT * horizontalPixelRatio));
        const step = dot + Math.max(1, Math.round(GAP * horizontalPixelRatio));
        ctx.fillStyle = state.color;
        for (let x = 0; x < bitmapSize.width; x += step) ctx.fillRect(x, top, dot, thickness);
      },
    );
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.font = this.font;
      const width =
        Math.round(ctx.measureText(state.tag).width) + TAG.paddingLeft + TAG.paddingRight;
      const { a: scaleX, d: scaleY } = ctx.getTransform();
      const right = mediaSize.width;
      const left = snapToDevicePixel(right - width, scaleX);
      const topEdge = snapToDevicePixel(labelY - TAG.height / 2, scaleY);
      const bottom = snapToDevicePixel(labelY + TAG.height / 2, scaleY);
      ctx.fillStyle = state.color;
      ctx.beginPath();
      ctx.roundRect(left, topEdge, right - left, bottom - topEdge, [TAG.radius, 0, 0, TAG.radius]);
      ctx.fill();
      ctx.fillStyle = this.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(state.tag, left + TAG.paddingLeft, labelY);
    });
  }

  private drawLabel(target: DrawTarget): void {
    const { state, labelY } = this;
    if (!state || labelY === null) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      drawAxisLabel(
        ctx,
        labelY,
        [state.text],
        {
          background: state.color,
          color: this.textColor,
          font: this.font,
          rowHeight: AXIS_LABEL.priceRowHeight,
          radii: [0, TAG.radius, TAG.radius, 0],
        },
        {
          tickYs: this.axisContext.tickYs(),
          background: this.axisContext.background,
          axisWidth: mediaSize.width,
        },
      );
    });
  }
}
