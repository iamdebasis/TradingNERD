/**
 * A drawing's color as its editors show it: the color and its opacity apart, stored together as
 * "#RRGGBB", or "#RRGGBBAA" when it isn't opaque (docs/SPEC.md §5.27).
 */
export function splitColor(color: string): { hex: string; opacity: number } {
  const hex = /^#[0-9A-Fa-f]{6}/.test(color) ? color.slice(0, 7).toUpperCase() : '#000000';
  const alpha = color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) : 255;
  return { hex, opacity: Number.isFinite(alpha) ? alpha / 255 : 1 };
}

export function joinColor(hex: string, opacity: number): string {
  const base = splitColor(hex).hex;
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  return alpha === 255 ? base : `${base}${alpha.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** A color for CSS: "#RRGGBBAA" works there as it is. */
export const cssColor = (color: string) => color;

/**
 * The palette's rows: TradingView's grays and its main colors (its Help Center's color picker;
 * the shades between them are left for when a screenshot shows them: provisional, §11).
 */
export const PALETTE: readonly (readonly string[])[] = [
  [
    '#FFFFFF',
    '#D1D4DC',
    '#B2B5BE',
    '#9598A1',
    '#787B86',
    '#5D606B',
    '#434651',
    '#2A2E39',
    '#131722',
    '#000000',
  ],
  [
    '#F23645',
    '#FF9800',
    '#FFEB3B',
    '#4CAF50',
    '#089981',
    '#00BCD4',
    '#2962FF',
    '#673AB7',
    '#9C27B0',
    '#E91E63',
  ],
];
