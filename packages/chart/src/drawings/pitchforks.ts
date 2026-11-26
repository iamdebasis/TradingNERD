import type { DrawingStyle, PitchforkTool } from '@tradingnerd/core';
import { FILL_REACH, lineSegment, opacityOf, type Pt, type Size } from './geometry';
import type { FillArea, LookLine, PartHandle, ShapeParts } from './parts';

/**
 * TradingView's four pitchforks on a pane (docs/SPEC.md §6.24, milestone D2), each three points
 * in CSS px: a median line, and each visible level's two lines beside it, parallel to it, the
 * level's coefficient times half the way from the middle of points 2 and 3 to each of them (so
 * the level at 1 runs through points 2 and 3), with the bands between them filled. Built on
 * screen, as the channels are.
 *
 * Where the median starts and which way it runs (provisional, §11):
 * - Pitchfork: from point 1 through the middle of points 2 and 3 (every source agrees).
 * - Schiff: from point 1's bar, halfway between points 1 and 2 in price, through that middle:
 *   the third-party capture (deepentropy/lightweight-charts-drawing, MIT) and a community guide
 *   on TradingView (Trendoscope, Know Your Pitchforks, 2023). TradingView's Help Center page for
 *   it repeats the Modified Schiff's words, halfway in time too.
 * - Modified Schiff: from halfway between points 1 and 2 in bar and price, through that middle
 *   (Help Center, Modified Schiff pitchfork; the capture; the guide).
 * - Inside: from the middle of points 2 and 3, parallel to the line from halfway between points
 *   1 and 2 to point 3 (the capture; the guide's "inside" handle, joining the base at point 3).
 */

/** Where a pitchfork's median starts, which way it runs, and its points 2 and 3's middle. */
export interface PitchforkFrame {
  origin: Pt;
  direction: Pt;
  /** The middle of points 2 and 3, where the levels are measured from. */
  base: Pt;
  /** Half the way from point 2 to point 3: a level's offset at coefficient 1. */
  half: Pt;
}

const middle = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function pitchforkFrame(tool: PitchforkTool, points: readonly Pt[]): PitchforkFrame | null {
  const [p1, p2, p3] = points;
  if (!p1 || !p2 || !p3) return null;
  const base = middle(p2, p3);
  const half = { x: (p3.x - p2.x) / 2, y: (p3.y - p2.y) / 2 };
  let origin: Pt;
  let direction: Pt;
  switch (tool) {
    case 'schiff-pitchfork':
      origin = { x: p1.x, y: (p1.y + p2.y) / 2 };
      direction = { x: base.x - origin.x, y: base.y - origin.y };
      break;
    case 'modified-schiff-pitchfork':
      origin = middle(p1, p2);
      direction = { x: base.x - origin.x, y: base.y - origin.y };
      break;
    case 'inside-pitchfork': {
      const from = middle(p1, p2);
      origin = base;
      direction = { x: p3.x - from.x, y: p3.y - from.y };
      break;
    }
    default:
      origin = p1;
      direction = { x: base.x - p1.x, y: base.y - p1.y };
  }
  if (Math.hypot(direction.x, direction.y) < 1e-9) return null;
  return { origin, direction, base, half };
}

/**
 * A pitchfork as drawn: its median (the main look, unless turned off) and the line from point 2
 * to point 3; each visible level's two lines in their own looks; the bands between the median
 * and the first level, and each level and the next, on each side, in the outer level's color at
 * the background's opacity. Every line runs from its start to the pane's edge it points to, and
 * back past its start with Extend lines (Help Center, Modified Schiff: "extend backwards").
 */
export function pitchfork(
  tool: PitchforkTool,
  points: readonly Pt[],
  style: DrawingStyle,
  size: Size,
): ShapeParts | null {
  const [p1, p2, p3] = points;
  if (!p1 || !p2 || !p3) return null;
  const handles: PartHandle[] = [
    { ...p1, point: 0, square: false },
    { ...p2, point: 1, square: false },
    { ...p3, point: 2, square: false },
  ];
  const connector = lineSegment(p2, p3, false, false, size);
  const frame = pitchforkFrame(tool, points);
  if (!frame) {
    // Points 1 and the middle of 2 and 3 in one place: no direction, only the line from 2 to 3.
    return {
      lines: connector ? [connector] : [],
      looks: [],
      fills: [],
      fillsTakeClicks: false,
      handles,
      frame: null,
    };
  }
  const { origin, direction, base, half } = frame;
  const ray = (start: Pt, margin?: number) =>
    lineSegment(
      start,
      { x: start.x + direction.x, y: start.y + direction.y },
      style.extendLines,
      true,
      size,
      margin,
    );
  const startOf = (coeff: number, side: 1 | -1): Pt => ({
    x: base.x + half.x * coeff * side,
    y: base.y + half.y * coeff * side,
  });
  const lines: [Pt, Pt][] = [];
  if (style.lineVisible) {
    const median = ray(origin);
    if (median) lines.push(median);
  }
  if (connector) lines.push(connector);
  const levels = style.levels.filter((level) => level.visible).sort((x, y) => x.coeff - y.coeff);
  const looks: LookLine[] = [];
  const fills: FillArea[] = [];
  const opacity = opacityOf(style.fill.color);
  for (const side of [1, -1] as const) {
    let inner = ray(startOf(0, side), FILL_REACH);
    for (const level of levels) {
      const start = startOf(level.coeff, side);
      const shown = ray(start);
      if (shown) {
        const { coeff, color, width, lineStyle } = level;
        looks.push({ a: shown[0], b: shown[1], color, width, lineStyle, coeff });
      }
      const outer = ray(start, FILL_REACH);
      if (style.fill.on && inner && outer) {
        fills.push({
          points: [inner[0], inner[1], outer[1], outer[0]],
          color: level.color,
          opacity,
        });
      }
      inner = outer;
    }
  }
  return { lines, looks, fills, fillsTakeClicks: false, handles, frame: null };
}
