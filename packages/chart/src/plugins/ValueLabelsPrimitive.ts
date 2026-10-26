import type {
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { stackLabels } from '../indicators/model';
import { AXIS_LABEL, type AxisContext, type DrawTarget, drawAxisLabel } from './axisLabel';

/** One plot's latest value on its pane's price axis. */
export interface ValueLabel {
  price: number;
  text: string;
  /** The plot's color: the label's background. */
  color: string;
}

/**
 * Dark text on light labels (RSI's yellow MA), white on the rest: ours, provisional until
 * measured (docs/SPEC.md §11).
 */
const DARK_TEXT = '#000000';

/** Relative luminance of "#RRGGBB" (WCAG), 0 for black to 1 for white. */
export function luminance(color: string): number {
  const value = Number.parseInt(color.slice(1, 7), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * TradingView's indicator value labels ("Indicators and financials" value labels, on by default):
 * each visible plot's latest value in a compact box of its color on the pane's price axis, in
 * the same style as the last price's label. Labels that would cover each other are stacked.
 */
export class ValueLabelsPrimitive implements ISeriesPrimitive<Time> {
  private readonly font: string;
  private readonly lightText: string;
  private readonly axisContext: AxisContext;
  private readonly views: readonly IPrimitivePaneView[];
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private labels: readonly ValueLabel[] = [];

  constructor(font: string, lightText: string, axisContext: AxisContext) {
    this.font = font;
    this.lightText = lightText;
    this.axisContext = axisContext;
    this.views = [{ zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.draw(t) }) }];
  }

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  update(labels: readonly ValueLabel[]): void {
    this.labels = labels;
    this.requestUpdate?.();
  }

  current(): readonly ValueLabel[] {
    return this.labels;
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: DrawTarget): void {
    const { series } = this;
    if (!series || this.labels.length === 0) return;
    const placed: { label: ValueLabel; y: number }[] = [];
    for (const label of this.labels) {
      const y = series.priceToCoordinate(label.price);
      if (y !== null && Number.isFinite(y)) placed.push({ label, y });
    }
    if (placed.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ys = stackLabels(
        placed.map((p) => p.y),
        AXIS_LABEL.priceRowHeight,
        mediaSize.height,
      );
      placed.forEach(({ label }, i) => {
        drawAxisLabel(
          ctx,
          ys[i] as number,
          [label.text],
          {
            background: label.color,
            color: luminance(label.color) > 0.5 ? DARK_TEXT : this.lightText,
            font: this.font,
            rowHeight: AXIS_LABEL.priceRowHeight,
          },
          {
            tickYs: this.axisContext.tickYs(),
            background: this.axisContext.background,
            axisWidth: mediaSize.width,
          },
        );
      });
    });
  }
}
