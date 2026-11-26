import type { DrawingStyle, DrawingTool } from '@tradingnerd/core';
import { FILL_REACH, lineSegment, type Pt, type Size } from './geometry';
import { type FillArea, frameOf, type LookLine, type PartHandle, type ShapeParts } from './parts';

/**
 * TradingView's channels on a pane (docs/SPEC.md §6.24, milestone D2): the Parallel channel, the
 * Flat top/bottom and the Disjoint channel, each three points in CSS px. Built on screen, so a
 * parallel channel's lines stay parallel on a log scale too. The constructions are a third-party
 * capture of TradingView's (deepentropy/lightweight-charts-drawing, MIT), the only account of
 * them found; TradingView's Help Center gives each tool's clicks and settings but not its
 * geometry. Provisional until measured from the user's screenshots (§11).
 */

/**
 * How far below its first line a parallel channel's second line runs (screen y; negative is
 * above): its third point's distance from the first line at that point's x, so a third point
 * kept anywhere along the second line gives the same channel.
 */
export function channelOffset(a: Pt, b: Pt, c: Pt): number {
  const t = b.x === a.x ? 0 : (c.x - a.x) / (b.x - a.x);
  return c.y - (a.y + (b.y - a.y) * t);
}

const down = (p: Pt, dy: number): Pt => ({ x: p.x, y: p.y + dy });
const middle = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** A drawing's lines from `a` to `b`, extended as its style says, as shown and as filled. */
function extended(a: Pt, b: Pt, style: DrawingStyle, size: Size) {
  return {
    shown: lineSegment(a, b, style.extendLeft, style.extendRight, size),
    filled: lineSegment(a, b, style.extendLeft, style.extendRight, size, FILL_REACH),
  };
}

/** The area between two lines (each from its first point to its second, as filled). */
function band(
  first: [Pt, Pt] | null,
  second: [Pt, Pt] | null,
  color: string,
  opacity = 1,
): FillArea[] {
  if (!first || !second) return [];
  return [{ points: [first[0], first[1], second[1], second[0]], color, opacity }];
}

/**
 * A Parallel channel: its first line through points 1 and 2, its second the first moved down
 * (or up) to point 3, each visible level the first moved its coefficient's share of the way;
 * the background across all of them. Six handles: the lines' ends, then their middles.
 */
export function parallelChannel(
  points: readonly Pt[],
  style: DrawingStyle,
  size: Size,
): ShapeParts | null {
  const [a, b, c] = points;
  if (!a || !b || !c) return null;
  const dy = channelOffset(a, b, c);
  const line = (coeff: number) => extended(down(a, dy * coeff), down(b, dy * coeff), style, size);
  const first = line(0);
  const second = line(1);
  const lines = [first.shown, second.shown].filter((item): item is [Pt, Pt] => item !== null);
  const visible = style.levels.filter((level) => level.visible);
  const looks: LookLine[] = [];
  for (const level of visible) {
    const shown = line(level.coeff).shown;
    if (shown) {
      const { coeff, color, width, lineStyle } = level;
      looks.push({ a: shown[0], b: shown[1], color, width, lineStyle, coeff });
    }
  }
  let fills: FillArea[] = [];
  if (style.fill.on) {
    // One area from the lowest line to the highest: the same as a band between each pair, with
    // no seams where two would meet.
    const coeffs = [0, 1, ...visible.map((level) => level.coeff)];
    const low = line(Math.min(...coeffs)).filled;
    const high = line(Math.max(...coeffs)).filled;
    fills = band(low, high, style.fill.color);
  }
  const mid = middle(a, b);
  const handles: PartHandle[] = [
    { ...a, point: 0, square: false },
    { ...b, point: 1, square: false },
    { ...down(a, dy), point: 2, square: false },
    { ...down(b, dy), point: 3, square: false },
    { ...down(mid, dy), point: 4, square: true },
    { ...mid, point: 5, square: true },
  ];
  return {
    lines,
    looks,
    fills,
    fillsTakeClicks: true,
    handles,
    frame: frameOf([a, b], [down(a, dy), down(b, dy)]),
  };
}

/**
 * A Flat top/bottom: its sloped line through points 1 and 2, and a flat one at point 3's price
 * over the same bars (Help Center: the third click "places the flat, horizontal boundary"), the
 * background between them. Four handles: the sloped line's ends, then the flat line's.
 */
export function flatTopBottom(
  points: readonly Pt[],
  style: DrawingStyle,
  size: Size,
): ShapeParts | null {
  const [a, b, c] = points;
  if (!a || !b || !c) return null;
  const flatA = { x: a.x, y: c.y };
  const flatB = { x: b.x, y: c.y };
  return angledChannel(a, b, flatA, flatB, style, size);
}

/**
 * A Disjoint channel: its first line through points 1 and 2, its second the first mirrored, over
 * the same bars, ending at point 3's price at point 2's bar, so the two open or close like an
 * angle (TradingView's own name for it was Disjoint angle, and its menu icon shows two lines
 * spreading apart; its Help Center calls them parallel, which neither shows). Four handles: the
 * first line's ends, then the second's, its end first.
 */
export function disjointChannel(
  points: readonly Pt[],
  style: DrawingStyle,
  size: Size,
): ShapeParts | null {
  const [a, b, c] = points;
  if (!a || !b || !c) return null;
  const end = { x: b.x, y: c.y };
  const start = { x: a.x, y: c.y + (b.y - a.y) };
  const parts = angledChannel(a, b, start, end, style, size);
  // Its handles: the second line's end (point 3) before its start.
  parts.handles = [
    { ...a, point: 0, square: false },
    { ...b, point: 1, square: false },
    { ...end, point: 2, square: true },
    { ...start, point: 3, square: true },
  ];
  return parts;
}

/** Two lines over the same bars, from `a` to `b` and `c` to `d`, filled between. */
function angledChannel(a: Pt, b: Pt, c: Pt, d: Pt, style: DrawingStyle, size: Size): ShapeParts {
  const first = extended(a, b, style, size);
  const second = extended(c, d, style, size);
  return {
    lines: [first.shown, second.shown].filter((item): item is [Pt, Pt] => item !== null),
    looks: [],
    fills: style.fill.on ? band(first.filled, second.filled, style.fill.color) : [],
    fillsTakeClicks: true,
    handles: [
      { ...a, point: 0, square: false },
      { ...b, point: 1, square: false },
      { ...c, point: 2, square: true },
      { ...d, point: 3, square: true },
    ],
    frame: frameOf([a, b], [c, d]),
  };
}

/**
 * A channel's points as kept once placed, in bars (x) and screen y: a parallel channel's third at
 * its first point's bar, at its offset (TradingView's _convertLastPointTo3rdPoint, as the
 * capture names it), so moving an end keeps its width; a flat top/bottom's and disjoint channel's
 * third at the second point's bar, only its price counting. Others as they are.
 */
export function placedPoints(tool: DrawingTool, points: readonly Pt[]): Pt[] {
  const [a, b, c] = points;
  if (!a || !b || !c) return points.map((point) => ({ ...point }));
  switch (tool) {
    case 'parallel-channel':
      return [{ ...a }, { ...b }, down(a, channelOffset(a, b, c))];
    case 'flat-top-bottom':
    case 'disjoint-channel':
      return [{ ...a }, { ...b }, { x: b.x, y: c.y }];
    default:
      return points.map((point) => ({ ...point }));
  }
}

/**
 * Where a channel's points go when handle `handle` is dragged to `to`, in bars (x) and screen y
 * (the capture's rules): a parallel channel's ends keep its width, its second line's middle sets
 * the width, its first line's middle moves it all up or down; a flat top/bottom's flat handles
 * and a disjoint channel's second line's set only prices. Null for a handle that moves its own
 * point, as every line tool's does.
 */
export function dragChannelHandle(
  tool: DrawingTool,
  points: readonly Pt[],
  handle: number,
  to: Pt,
): Pt[] | null {
  const [a, b, c] = points;
  if (!a || !b || !c) return null;
  switch (tool) {
    case 'parallel-channel': {
      const dy = channelOffset(a, b, c);
      const mid = middle(a, b);
      switch (handle) {
        case 0:
          return [{ ...to }, { ...b }, down(to, dy)];
        case 1:
          return [{ ...a }, { ...to }, down(a, dy)];
        case 2:
          return [down(to, -dy), { ...b }, { ...to }];
        case 3:
          return [{ ...a }, down(to, -dy), down(a, dy)];
        case 4:
          return [{ ...a }, { ...b }, down(a, to.y - mid.y)];
        case 5: {
          const shift = to.y - mid.y;
          return [down(a, shift), down(b, shift), down(a, dy + shift)];
        }
        default:
          return null;
      }
    }
    case 'flat-top-bottom':
      switch (handle) {
        case 0:
          return [{ ...to }, { ...b }, { x: b.x, y: c.y }];
        case 1:
          return [{ ...a }, { ...to }, { x: to.x, y: c.y }];
        case 2:
        case 3:
          return [{ ...a }, { ...b }, { x: b.x, y: to.y }];
        default:
          return null;
      }
    case 'disjoint-channel':
      switch (handle) {
        case 0:
          return [{ ...to }, { ...b }, { x: b.x, y: c.y }];
        case 1:
          return [{ ...a }, { ...to }, { x: to.x, y: c.y }];
        case 2:
          return [{ ...a }, { ...b }, { x: b.x, y: to.y }];
        case 3:
          // The second line's start mirrors the first's: moving it moves point 1's price.
          return [{ x: a.x, y: c.y + b.y - to.y }, { ...b }, { x: b.x, y: c.y }];
        default:
          return null;
      }
    default:
      return null;
  }
}
