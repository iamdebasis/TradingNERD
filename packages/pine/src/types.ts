import type { Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import type { Value } from './values.ts';

/**
 * Pine's qualifiers, weakest first (Pine docs, Type system): const (known when compiling), input
 * (from the Inputs tab), simple (known on the first bar), series (may change on every bar). An
 * expression takes its strongest operand's.
 */
export type Qual = 0 | 1 | 2 | 3;
export const CONST: Qual = 0;
export const INPUT: Qual = 1;
export const SIMPLE: Qual = 2;
export const SERIES: Qual = 3;
export const QUAL_NAMES = ['const', 'input', 'simple', 'series'] as const;

/**
 * Value types: Pine's fundamental ones, plot and hline handles, the style constants' own types
 * (plot.style_* is a plot_style, hline.style_* an hline_style, plot.linestyle_* a
 * plot_line_style: the v6 reference), void, untyped na, tuples.
 */
export type Base =
  | 'int'
  | 'float'
  | 'bool'
  | 'color'
  | 'string'
  | 'plot'
  | 'hline'
  | 'plot_style'
  | 'hline_style'
  | 'plot_line_style'
  | 'void'
  | 'na'
  | 'tuple';

/** Types whose values are strings while the script runs. */
export const isStringLike = (base: Base) =>
  base === 'string' ||
  base === 'plot_style' ||
  base === 'hline_style' ||
  base === 'plot_line_style';

export const maxQual = (...quals: Qual[]): Qual => Math.max(CONST, ...quals) as Qual;

/** The input values, by input, that const and input expressions are worked out from. */
export interface FoldEnv {
  inputs: readonly Value[];
}

/** A compiled expression: its type and qualifier, how to run it, and its value if known early. */
export interface Compiled {
  base: Base;
  /** A tuple's item types. */
  items?: Base[];
  qual: Qual;
  ev: (rt: Runtime) => Value;
  /** For const and input expressions: the value, from the inputs alone. */
  fold?: (env: FoldEnv) => Value;
  span: Span;
}

/** How a type reads in messages: "series float", "const int". */
export function typeName(c: { base: Base; qual: Qual }): string {
  return `${QUAL_NAMES[c.qual]} ${c.base}`;
}

export const isNumeric = (base: Base) => base === 'int' || base === 'float' || base === 'na';

/** The type two values unify to (int and float give float; na gives the other), or null. */
export function unify(a: Base, b: Base): Base | null {
  if (a === b) return a;
  if (a === 'na') return b;
  if (b === 'na') return a;
  if ((a === 'int' && b === 'float') || (a === 'float' && b === 'int')) return 'float';
  return null;
}

/** Whether a value of type `from` may go where `to` is expected (int → float; na → anything). */
export function assignable(from: Base, to: Base): boolean {
  return from === to || from === 'na' || (from === 'int' && to === 'float');
}

/** The value a type's na is at run time: NaN for numbers and colors, null for strings, false for bools. */
export function naOf(base: Base): Value {
  if (isStringLike(base)) return null;
  if (base === 'bool') return false;
  return Number.NaN;
}
