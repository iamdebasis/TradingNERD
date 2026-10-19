import { parseSymbolId, type SymbolId } from './market.ts';

/**
 * TradingView's flag colors, in its palette's order (docs/reference/06-watchlist-flags.png):
 * red, blue, green, yellow, purple, cyan, pink.
 */
export const FLAG_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'cyan', 'pink'] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

export function isFlagColor(value: unknown): value is FlagColor {
  return FLAG_COLORS.some((color) => color === value);
}

/**
 * Flagged symbols. As in TradingView a flag belongs to the symbol, not to a list: it stays when
 * the symbol leaves the watchlist. Kept by the gateway in `data/flags.json`.
 */
export interface FlagState {
  /** Each flagged symbol's color. */
  flags: Record<SymbolId, FlagColor>;
  /** What a new flag gets (a click on a row's flag, Alt+Enter): the color last picked. */
  lastColor: FlagColor;
}

export const DEFAULT_FLAG_STATE: Readonly<FlagState> = Object.freeze({
  flags: Object.freeze({}) as Record<SymbolId, FlagColor>,
  lastColor: 'red',
});

export const MAX_FLAGS = 10_000;

/**
 * A valid flag state from anything (a PUT body, the stored file), normalized: canonical symbol
 * ids and known colors only. Null if it isn't one at all or holds too many flags.
 */
export function parseFlagState(value: unknown): FlagState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { flags, lastColor } = value as Record<string, unknown>;
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return null;
  const entries = Object.entries(flags);
  if (entries.length > MAX_FLAGS) return null;
  const kept: Record<SymbolId, FlagColor> = {};
  for (const [symbol, color] of entries) {
    const parsed = parseSymbolId(symbol);
    if (parsed && isFlagColor(color)) kept[`${parsed.exchange}:${parsed.ticker}`] = color;
  }
  return { flags: kept, lastColor: isFlagColor(lastColor) ? lastColor : 'red' };
}
