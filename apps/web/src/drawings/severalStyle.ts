import type { ChartController } from '@tradingnerd/chart';
import {
  type Displacement,
  type DisplacementAxis,
  type Drawing,
  type DrawingLineStyle,
  type DrawingTool,
  displace,
  recolorDrawing,
  TOOL_OPTIONS,
} from '@tradingnerd/core';

/**
 * The style of several drawings at once (docs/SPEC.md §5.27, D3c2): "Selected Drawings" and a
 * group's settings, and the floating toolbar for drawings of different tools, as TradingView's
 * images show them: a Line row, then Background and Text when any of the drawings has one (its
 * Help Center GIF 43000660419-2, November 2024: a path and an ellipse get the ellipse's
 * Background; the toolbar in its blog GIF of December 2021). A value they differ in shows as a
 * rainbow; a change sets each drawing that has it.
 */

/** A value of several drawings: the first's, and whether the others differ from it. */
export interface Shared<T> {
  value: T;
  mixed: boolean;
}

function shared<T>(values: readonly T[]): Shared<T> | null {
  const [first] = values;
  if (first === undefined) return null;
  return { value: first, mixed: values.some((value) => value !== first) };
}

/** A drawing has a line to style unless it's only text (later milestones). */
export function hasLine(tool: DrawingTool): boolean {
  const options = TOOL_OPTIONS[tool];
  return (
    options.extend ||
    options.extendMenu ||
    options.extendLines ||
    options.showPrice ||
    options.showTime ||
    options.stats
  );
}

/** A drawing with a background: the channels' color, the pitchforks' opacity. */
export const hasFill = (tool: DrawingTool) => TOOL_OPTIONS[tool].fill !== 'none';

/** A drawing with text of its own. */
export const hasText = (tool: DrawingTool) => TOOL_OPTIONS[tool].text;

export interface SeveralStyle {
  line: {
    color: Shared<string>;
    width: Shared<number>;
    lineStyle: Shared<DrawingLineStyle>;
  } | null;
  fill: { on: Shared<boolean>; color: Shared<string> } | null;
  text: Shared<string> | null;
}

export function severalStyle(drawings: readonly Drawing[]): SeveralStyle {
  const lined = drawings.filter((drawing) => hasLine(drawing.tool));
  const filled = drawings.filter((drawing) => hasFill(drawing.tool));
  const texted = drawings.filter((drawing) => hasText(drawing.tool));
  const color = shared(lined.map((drawing) => drawing.style.color));
  const width = shared(lined.map((drawing) => drawing.style.width));
  const lineStyle = shared(lined.map((drawing) => drawing.style.lineStyle));
  const on = shared(filled.map((drawing) => drawing.style.fill.on));
  const fillColor = shared(filled.map((drawing) => drawing.style.fill.color));
  return {
    line: color && width && lineStyle ? { color, width, lineStyle } : null,
    fill: on && fillColor ? { on, color: fillColor } : null,
    text: shared(texted.map((drawing) => drawing.style.text.color)),
  };
}

/**
 * The line's color on each drawing with a line, the whole drawing taking it as the floating
 * toolbar's does (a channel's levels and background, a pitchfork's levels: core's recolorDrawing).
 */
export function withLineColor(drawings: readonly Drawing[], color: string): Drawing[] {
  return drawings.map((drawing) =>
    hasLine(drawing.tool) ? recolorDrawing(drawing, color) : drawing,
  );
}

/** The line's thickness or style on each drawing with a line. */
export function withLine(
  drawings: readonly Drawing[],
  change: { width?: number; lineStyle?: DrawingLineStyle },
): Drawing[] {
  return drawings.map((drawing) =>
    hasLine(drawing.tool) ? { ...drawing, style: { ...drawing.style, ...change } } : drawing,
  );
}

/** The background, on or off or its color, on each drawing with one. */
export function withFill(
  drawings: readonly Drawing[],
  change: { on?: boolean; color?: string },
): Drawing[] {
  return drawings.map((drawing) =>
    hasFill(drawing.tool)
      ? { ...drawing, style: { ...drawing.style, fill: { ...drawing.style.fill, ...change } } }
      : drawing,
  );
}

/** The text's color on each drawing with text. */
export function withTextColor(drawings: readonly Drawing[], color: string): Drawing[] {
  return drawings.map((drawing) =>
    hasText(drawing.tool)
      ? { ...drawing, style: { ...drawing.style, text: { ...drawing.style.text, color } } }
      : drawing,
  );
}

/**
 * The drawings after a Displacement (D3c2): each point's price, or its bar (through the chart's
 * bars, as the Coordinates tab's), changed by the expression. A locked drawing stays where it is,
 * as a lock keeps it from being moved (ours, provisional §11).
 */
export function displaceDrawings(
  drawings: readonly Drawing[],
  axis: DisplacementAxis,
  by: Displacement,
  chart: Pick<ChartController, 'drawingBarOf' | 'drawingTimeOf'> | null,
): Drawing[] {
  return drawings.map((drawing) => {
    if (drawing.locked) return drawing;
    if (axis === 'price') {
      return {
        ...drawing,
        points: drawing.points.map((point) => ({ ...point, price: displace(point.price, by) })),
      };
    }
    if (!chart) return drawing;
    return {
      ...drawing,
      points: drawing.points.map((point) => ({
        ...point,
        time: chart.drawingTimeOf(displace(chart.drawingBarOf(point.time), by)),
      })),
    };
  });
}
