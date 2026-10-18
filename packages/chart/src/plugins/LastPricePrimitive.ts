import type {
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { type AxisContext, type DrawTarget, drawAxisLabel } from './axisLabel';

export interface LastPriceState {
  price: number;
  /** Formatted price, e.g. "1.2955". */
  text: string;
  /** Time left in the current bar, e.g. "07:50:06"; null hides the second row. */
  countdown: string | null;
  /** Label and line color: green for an up bar, red for a down bar. */
  color: string;
}

/** Dot and gap of TradingView's last-price line, in CSS px. */
const DOT = 1;
const GAP = 3;

/**
 * TradingView's last-price marker: a dotted line across the pane and a two-line label on the
 * price axis (price, then the countdown to the bar's close).
 */
export class LastPricePrimitive implements ISeriesPrimitive<Time> {
  private readonly font: string;
  private readonly textColor: string;
  private readonly axisContext: AxisContext;
  private readonly pane: readonly IPrimitivePaneView[];
  private readonly axis: readonly IPrimitivePaneView[];
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private state: LastPriceState | null = null;
  private y: number | null = null;

  constructor(font: string, textColor: string, axisContext: AxisContext) {
    this.font = font;
    this.textColor = textColor;
    this.axisContext = axisContext;
    this.pane = [{ zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.drawLine(t) }) }];
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

  update(state: LastPriceState | null): void {
    this.state = state;
    this.requestUpdate?.();
  }

  /** What the label currently shows (the canvas can't be read back). */
  current(): LastPriceState | null {
    return this.state;
  }

  updateAllViews(): void {
    this.y = this.state && this.series ? this.series.priceToCoordinate(this.state.price) : null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.pane;
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.axis;
  }

  private drawLine(target: DrawTarget): void {
    const { state, y } = this;
    if (!state || y === null) return;
    target.useBitmapCoordinateSpace(
      ({ context: ctx, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
        // Whole device pixels keep the dots crisp at any zoom level.
        const thickness = Math.max(1, Math.floor(verticalPixelRatio));
        const top = Math.round(y * verticalPixelRatio) - Math.floor(thickness / 2);
        const dot = Math.max(1, Math.round(DOT * horizontalPixelRatio));
        const step = dot + Math.max(1, Math.round(GAP * horizontalPixelRatio));
        ctx.fillStyle = state.color;
        for (let x = 0; x < bitmapSize.width; x += step) ctx.fillRect(x, top, dot, thickness);
      },
    );
  }

  private drawLabel(target: DrawTarget): void {
    const { state, y } = this;
    if (!state || y === null) return;
    const rows = state.countdown ? [state.text, state.countdown] : [state.text];
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      drawAxisLabel(
        ctx,
        y,
        rows,
        { background: state.color, color: this.textColor, font: this.font },
        {
          tickYs: this.axisContext.tickYs(),
          background: this.axisContext.background,
          axisWidth: mediaSize.width,
        },
      );
    });
  }
}
