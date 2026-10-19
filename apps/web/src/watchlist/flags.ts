import type { FlagColor } from '@tradingnerd/core';
import type { CSSProperties } from 'react';

/**
 * TradingView's flag colors, measured (sRGB) from docs/reference/06-watchlist-flags.png: the
 * flags on its rows are the same colors as its palette's dots.
 */
export const FLAG_HEX: Readonly<Record<FlagColor, string>> = {
  red: '#FF5252',
  blue: '#2A79FF',
  green: '#81C784',
  yellow: '#FBC02D',
  purple: '#BA68C8',
  cyan: '#00E5FF',
  pink: '#F48FB1',
};

/** A flag while its palette is open: red as measured, the others a shade darker (provisional). */
const FLAG_OPEN_HEX: Partial<Record<FlagColor, string>> = { red: '#F23645' };

export const FLAG_NAMES: Readonly<Record<FlagColor, string>> = {
  red: 'Red',
  blue: 'Blue',
  green: 'Green',
  yellow: 'Yellow',
  purple: 'Purple',
  cyan: 'Cyan',
  pink: 'Pink',
};

/** A flag's color (`--flag`) and its shade while its palette is open (`--flag-open`). */
export function flagStyle(color: FlagColor): CSSProperties {
  const open = FLAG_OPEN_HEX[color] ?? `color-mix(in srgb, ${FLAG_HEX[color]} 88%, black)`;
  return { '--flag': FLAG_HEX[color], '--flag-open': open } as CSSProperties;
}
