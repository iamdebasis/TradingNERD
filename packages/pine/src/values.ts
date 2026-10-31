import { packColor } from './lexer.ts';

/**
 * How values live while a script runs: numbers (int and float) as JavaScript numbers with na as
 * NaN; bools as booleans (Pine's bool is never na); strings as strings, na as null; colors packed
 * into one number (red, green, blue and Pine's transparency in half percents), na as NaN.
 */
export type Value = number | boolean | string | null | readonly Value[] | OutputRef;

/** What plot() and hline() give back: a handle fill() takes. */
export interface OutputRef {
  readonly output: 'plot' | 'hline';
  readonly index: number;
}

export const isOutputRef = (value: unknown): value is OutputRef =>
  typeof value === 'object' && value !== null && 'output' in value;

export { packColor };

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** Pine's transparency, 0 (opaque) to 100 (clear). */
  t: number;
}

export function unpackColor(color: number): Rgba {
  return {
    r: Math.floor(color / 16777216) % 256,
    g: Math.floor(color / 65536) % 256,
    b: Math.floor(color / 256) % 256,
    t: (color % 256) / 2,
  };
}

/** "#RRGGBB" for a packed color. */
export function colorHex(color: number): string {
  const { r, g, b } = unpackColor(color);
  return `#${[r, g, b]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/** A packed color's opacity, 0 to 1 (the Style tab's opacity is 100 minus Pine's transparency). */
export function colorOpacity(color: number): number {
  return 1 - unpackColor(color).t / 100;
}

/** A packed color as CSS. */
export function colorCss(color: number): string {
  const { r, g, b, t } = unpackColor(color);
  return t === 0
    ? colorHex(color)
    : `rgba(${r}, ${g}, ${b}, ${Math.round((1 - t / 100) * 1000) / 1000})`;
}

/** Pine's `%`: the remainder after flooring the quotient (Pine docs, Arithmetic operators). */
export function mod(a: number, b: number): number {
  return a - b * Math.floor(a / b);
}

/** Pine's color constants in v6 (the v6 reference's values). */
export const COLORS: Readonly<Record<string, number>> = {
  aqua: hexColor('#00BCD4'),
  black: hexColor('#363A45'),
  blue: hexColor('#2962FF'),
  fuchsia: hexColor('#E040FB'),
  gray: hexColor('#787B86'),
  green: hexColor('#4CAF50'),
  lime: hexColor('#00E676'),
  maroon: hexColor('#880E4F'),
  navy: hexColor('#311B92'),
  olive: hexColor('#808000'),
  orange: hexColor('#FF9800'),
  purple: hexColor('#9C27B0'),
  red: hexColor('#F23645'),
  silver: hexColor('#B2B5BE'),
  teal: hexColor('#089981'),
  white: hexColor('#FFFFFF'),
  yellow: hexColor('#FDD835'),
};

/** A packed color from "#RRGGBB" or "#RRGGBBAA". */
export function hexColor(hex: string): number {
  const n = (k: number) => Number.parseInt(hex.slice(1 + k, 3 + k), 16);
  const alpha = hex.length === 9 ? n(6) : 255;
  return packColor(n(0), n(2), n(4), 100 * (1 - alpha / 255));
}

/** `color.new(c, transp)`: the same color at another transparency. */
export function withTransparency(color: number, transparency: number): number {
  if (Number.isNaN(color) || Number.isNaN(transparency)) return Number.NaN;
  const { r, g, b } = unpackColor(color);
  return packColor(r, g, b, transparency);
}

/**
 * `color.from_gradient`: where `value` sits between the bottom and top values, the color that
 * far from the bottom color to the top one, each channel in a straight line, the end colors
 * beyond (Pine docs, Colors; Pine's na colors count as fully transparent black).
 */
export function fromGradient(
  value: number,
  bottomValue: number,
  topValue: number,
  bottomColor: number,
  topColor: number,
): number {
  if (Number.isNaN(value) || Number.isNaN(bottomValue) || Number.isNaN(topValue)) return Number.NaN;
  const range = topValue - bottomValue;
  const share = range === 0 ? 0 : Math.min(1, Math.max(0, (value - bottomValue) / range));
  const from = Number.isNaN(bottomColor) ? { r: 0, g: 0, b: 0, t: 100 } : unpackColor(bottomColor);
  const to = Number.isNaN(topColor) ? { r: 0, g: 0, b: 0, t: 100 } : unpackColor(topColor);
  const mix = (a: number, b: number) => a + (b - a) * share;
  return packColor(
    Math.round(mix(from.r, to.r)),
    Math.round(mix(from.g, to.g)),
    Math.round(mix(from.b, to.b)),
    mix(from.t, to.t),
  );
}
