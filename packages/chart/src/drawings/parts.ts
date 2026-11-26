import type { DrawingLineStyle } from '@tradingnerd/core';
import type { Pt } from './geometry';

/**
 * A channel, pitchfork or regression trend as it shows on a pane, in CSS px from the pane's top
 * left (docs/SPEC.md §6.24): its main lines, drawn in the drawing's own look; the lines with a
 * look of their own (levels, a regression's Up and Down); its filled areas; its handles; and the
 * two lines its text runs along. Built by the pure functions of `channels.ts`, `pitchforks.ts`
 * and `regression.ts`, so each construction is tested on its own.
 */

/** A line with its own look. */
export interface LookLine {
  a: Pt;
  b: Pt;
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
  /** The level it draws, if it's a level's. */
  coeff?: number;
}

/** A filled area: its corners in order, its color and that color's opacity on top of its own. */
export interface FillArea {
  points: Pt[];
  color: string;
  opacity: number;
}

/** A handle: where it is, which handle of the drawing it is, and its shape. */
export interface PartHandle extends Pt {
  point: number;
  /** A rounded square (one that moves only part of the drawing), else a circle. */
  square: boolean;
}

/** Where a channel's text goes: along its upper line, its lower one, or between them. */
export interface TextFrame {
  upper: [Pt, Pt];
  lower: [Pt, Pt];
}

/** A short text the drawing writes beside itself (a regression trend's Pearson's R). */
export interface PartLabel {
  /** Its top middle. */
  at: Pt;
  text: string;
  color: string;
  size: number;
}

export interface ShapeParts {
  lines: [Pt, Pt][];
  looks: LookLine[];
  fills: FillArea[];
  /** A click inside the fills takes the drawing (a channel's background), else only its lines. */
  fillsTakeClicks: boolean;
  handles: PartHandle[];
  frame: TextFrame | null;
  label?: PartLabel | null;
}

/** The upper and lower of two lines on screen, by where they are halfway across the first. */
export function frameOf(first: [Pt, Pt], second: [Pt, Pt]): TextFrame {
  const x = (first[0].x + first[1].x) / 2;
  const yAt = ([a, b]: [Pt, Pt]) =>
    b.x === a.x ? (a.y + b.y) / 2 : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  return yAt(first) <= yAt(second)
    ? { upper: first, lower: second }
    : { upper: second, lower: first };
}
