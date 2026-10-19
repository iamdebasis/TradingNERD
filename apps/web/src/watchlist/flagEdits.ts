import type { FlagColor, FlagState, SymbolId } from '@tradingnerd/core';

/**
 * Edits to the flags, as TradingView makes them: pure functions, each returning a new state or
 * the same one when nothing changes.
 */

/** A row's flag clicked, or Alt+Enter: off if it's flagged, else on in the last color picked. */
export function toggleFlag(state: FlagState, symbol: SymbolId): FlagState {
  const { [symbol]: current, ...rest } = state.flags;
  if (current) return { ...state, flags: rest };
  return { ...state, flags: { ...state.flags, [symbol]: state.lastColor } };
}

/** A color picked: the symbol flagged in it, and it becomes the next flag's; its own color unflags. */
export function pickFlag(state: FlagState, symbol: SymbolId, color: FlagColor): FlagState {
  const { [symbol]: current, ...rest } = state.flags;
  if (current === color) return { ...state, flags: rest };
  return { flags: { ...state.flags, [symbol]: color }, lastColor: color };
}

export function unflagAll(state: FlagState): FlagState {
  return Object.keys(state.flags).length === 0 ? state : { ...state, flags: {} };
}

export function flagOf(state: FlagState | null, symbol: SymbolId): FlagColor | null {
  return state?.flags[symbol] ?? null;
}
