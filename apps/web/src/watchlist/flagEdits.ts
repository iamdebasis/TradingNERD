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

/** The flags without those of `symbols`. */
function without(state: FlagState, symbols: readonly SymbolId[]): FlagState {
  const off = new Set(symbols);
  const flags = Object.fromEntries(
    Object.entries(state.flags).filter(([symbol]) => !off.has(symbol)),
  );
  return { ...state, flags };
}

/**
 * Alt+Enter, or the menu's flag, on several selected symbols (TradingView's "Flag All
 * Selected"): the unflagged ones flagged in the last color picked, those flagged keeping theirs;
 * when every one is flagged, all of them unflagged.
 */
export function toggleFlags(state: FlagState, symbols: readonly SymbolId[]): FlagState {
  if (symbols.length === 0) return state;
  if (symbols.every((symbol) => state.flags[symbol])) return without(state, symbols);
  const flags = { ...state.flags };
  for (const symbol of symbols) flags[symbol] ??= state.lastColor;
  return { ...state, flags };
}

/**
 * A color picked for several selected symbols: all of them flagged in it, and it becomes the next
 * flag's; when every one has it already, all of them unflagged.
 */
export function pickFlags(
  state: FlagState,
  symbols: readonly SymbolId[],
  color: FlagColor,
): FlagState {
  if (symbols.length === 0) return state;
  if (symbols.every((symbol) => state.flags[symbol] === color)) return without(state, symbols);
  const flags = { ...state.flags };
  for (const symbol of symbols) flags[symbol] = color;
  return { flags, lastColor: color };
}

/** The color every one of `symbols` is flagged in, if they share one. */
export function sharedFlag(
  state: FlagState | null,
  symbols: readonly SymbolId[],
): FlagColor | null {
  const first = symbols[0] === undefined ? null : flagOf(state, symbols[0]);
  return first && symbols.every((symbol) => flagOf(state, symbol) === first) ? first : null;
}

export function unflagAll(state: FlagState): FlagState {
  return Object.keys(state.flags).length === 0 ? state : { ...state, flags: {} };
}

export function flagOf(state: FlagState | null, symbol: SymbolId): FlagColor | null {
  return state?.flags[symbol] ?? null;
}
