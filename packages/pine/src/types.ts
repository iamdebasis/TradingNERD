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
 * A value's type, as text (see ast.ts, TypeRef): the fundamental types; plot and hline handles;
 * the style constants' own types (plot.style_* is a plot_style, hline.style_* an hline_style,
 * plot.linestyle_* a plot_line_style, shape.* a shape_style, location.* a location_style,
 * size.* a size_style: the v6 reference); collections ("array<float>", "map<string, int>",
 * "matrix<float>"); drawing types; user-defined types and enums by their key (Compiler.types);
 * void, untyped na and tuples.
 */
export type Base = string;

/** Types whose values are strings while the script runs. */
const STRING_LIKE: ReadonlySet<string> = new Set([
  'string',
  'plot_style',
  'hline_style',
  'plot_line_style',
  'shape_style',
  'location_style',
  'size_style',
  'xloc_style',
  'yloc_style',
  'text_align',
  'text_wrap',
  'text_format',
  'font_family',
  'line_style',
  'label_style',
  'extend_style',
  'position_style',
  'barmerge_gaps',
  'barmerge_lookahead',
  'order_style',
  'scale_style',
  'currency_style',
  'adjustment_style',
  'dividends_style',
  'earnings_style',
  'splits_style',
  'session_style',
  'backadjustment_style',
  'settlement_style',
]);

export const isStringLike = (base: Base) => STRING_LIKE.has(base);

/** Pine's unique types: the style constants, which never take na in v6 (v6 migration guide). */
export const isUniqueType = (base: Base) => base !== 'string' && STRING_LIKE.has(base);

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
  /** A literal or a built-in constant (v6 refuses their history). */
  literal?: boolean;
}

/** How a type reads in messages: "series float", "const int", "array<float>". */
export function typeName(c: { base: Base; qual: Qual }): string {
  const base = displayType(c.base);
  return isReferenceType(c.base) ? base : `${QUAL_NAMES[c.qual]} ${base}`;
}

/** A type as the script would write it: a library's types keep their alias-free name. */
export function displayType(base: Base): string {
  return base.replace(/[^<>, ]*:/g, '');
}

export const isNumeric = (base: Base) => base === 'int' || base === 'float' || base === 'na';

/** Values kept in typed arrays: numbers and colors. */
export const isNumericSlot = (base: Base) => isNumeric(base) || base === 'color';

// ---- collections and objects ----

/** The type arguments of "array<float>", "map<string, array<int>>": ["string", "array<int>"]. */
export function typeArgs(base: Base): Base[] {
  const open = base.indexOf('<');
  if (open < 0 || !base.endsWith('>')) return [];
  const inner = base.slice(open + 1, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

export const genericName = (base: Base) => {
  const open = base.indexOf('<');
  return open < 0 ? base : base.slice(0, open);
};

export const isArrayType = (base: Base) => base.startsWith('array<');
export const isMatrixType = (base: Base) => base.startsWith('matrix<');
export const isMapType = (base: Base) => base.startsWith('map<');
export const isCollection = (base: Base) =>
  isArrayType(base) || isMatrixType(base) || isMapType(base);

export const arrayOf = (elem: Base): Base => `array<${elem}>`;
export const matrixOf = (elem: Base): Base => `matrix<${elem}>`;
export const mapOf = (key: Base, value: Base): Base => `map<${key}, ${value}>`;

/** An array's or matrix's element type. */
export const elemOf = (base: Base): Base => typeArgs(base)[0] ?? 'float';

/** The drawing types (Pine docs, Lines and boxes, Text and shapes, Tables). */
export const DRAWING_TYPES: ReadonlySet<string> = new Set([
  'label',
  'line',
  'box',
  'table',
  'linefill',
  'polyline',
  'chart.point',
]);

/** The fundamental types and the built-in special ones a declaration may name. */
export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'int',
  'float',
  'bool',
  'color',
  'string',
  ...DRAWING_TYPES,
]);

const VALUE_TYPES: ReadonlySet<string> = new Set([
  'int',
  'float',
  'bool',
  'color',
  'string',
  'plot',
  'hline',
  'void',
  'na',
  'tuple',
  ...STRING_LIKE,
]);

/** Types whose values are references: collections, drawings, objects and enums (na is null). */
export const isReferenceType = (base: Base) => !VALUE_TYPES.has(base);

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

/** The value a type's na is at run time: NaN for numbers and colors, false for bools, null else. */
export function naOf(base: Base): Value {
  if (base === 'bool') return false;
  if (base === 'int' || base === 'float' || base === 'color' || base === 'na') return Number.NaN;
  return null;
}

/** Converts a value to a declared type at run time: int → float stays a number; na → that type's na. */
export function castTo(c: Compiled, base: Base): (rt: Runtime) => Value {
  if (c.base === 'na') {
    const na = naOf(base);
    return () => na;
  }
  return c.ev;
}
