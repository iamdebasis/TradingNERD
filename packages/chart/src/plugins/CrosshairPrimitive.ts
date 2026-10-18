import type {
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import {
  AXIS_LABEL,
  type AxisContext,
  type DrawTarget,
  drawAxisLabel,
  snapToDevicePixel,
} from './axisLabel';

export interface CrosshairState {
  /** Pane y of the crosshair, in CSS px. */
  y: number;
  /** Formatted price at that height. */
  text: string;
}

/** The ⊕ box TradingView attaches to the left of the crosshair price label, in CSS px. */
const PLUS_BOX = { width: 23, radius: 3, circleRadius: 7, arm: 4, stroke: 1.25 } as const;

/**
 * TradingView's crosshair price label: a compact gray box on the price axis joined to a ⊕
 * button at the right edge of the pane. (The ⊕ menu itself is out of scope for M1.)
 * Drawn on the top layer, so it repaints with the cursor without redrawing the candles.
 */
export class CrosshairPrimitive implements ISeriesPrimitive<Time> {
  private readonly background: string;
  private readonly textColor: string;
  private readonly font: string;
  private readonly axisContext: AxisContext;
  private readonly pane: readonly IPrimitivePaneView[];
  private readonly axis: readonly IPrimitivePaneView[];
  private requestUpdate: (() => void) | null = null;
  private state: CrosshairState | null = null;

  constructor(background: string, textColor: string, font: string, axisContext: AxisContext) {
    this.background = background;
    this.textColor = textColor;
    this.font = font;
    this.axisContext = axisContext;
    this.pane = [{ zOrder: () => 'top', renderer: () => ({ draw: (t) => this.drawPlus(t) }) }];
    this.axis = [{ zOrder: () => 'top', renderer: () => ({ draw: (t) => this.drawLabel(t) }) }];
  }

  attached({ requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  update(state: CrosshairState | null): void {
    this.state = state;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.pane;
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.axis;
  }

  private drawPlus(target: DrawTarget): void {
    const { state } = this;
    if (!state) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width, radius, circleRadius, arm, stroke } = PLUS_BOX;
      const { a: scaleX, d: scaleY } = ctx.getTransform();
      const left = snapToDevicePixel(mediaSize.width - width, scaleX);
      const top = snapToDevicePixel(state.y - AXIS_LABEL.rowHeight / 2, scaleY);
      const bottom = snapToDevicePixel(state.y + AXIS_LABEL.rowHeight / 2, scaleY);
      ctx.fillStyle = this.background;
      ctx.beginPath();
      ctx.roundRect(left, top, mediaSize.width - left, bottom - top, [radius, 0, 0, radius]);
      ctx.fill();

      const cx = left + width / 2;
      ctx.strokeStyle = this.textColor;
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.arc(cx, state.y, circleRadius, 0, Math.PI * 2);
      ctx.moveTo(cx - arm, state.y);
      ctx.lineTo(cx + arm, state.y);
      ctx.moveTo(cx, state.y - arm);
      ctx.lineTo(cx, state.y + arm);
      ctx.stroke();
    });
  }

  private drawLabel(target: DrawTarget): void {
    const { state } = this;
    if (!state) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      drawAxisLabel(
        ctx,
        state.y,
        [state.text],
        {
          background: this.background,
          color: this.textColor,
          font: this.font,
          radii: [0, AXIS_LABEL.radius, AXIS_LABEL.radius, 0],
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
