import { MAX_WATCHLIST_SYMBOLS, type SymbolId, type Watchlist } from '@tradingnerd/core';

/** Edits to a watchlist, as pure functions: each returns a new list, or the same one if nothing changed. */

export function removeSymbol(list: Watchlist, symbol: SymbolId): Watchlist {
  if (!list.sections.some((section) => section.symbols.includes(symbol))) return list;
  return {
    sections: list.sections.map((section) => ({
      ...section,
      symbols: section.symbols.filter((item) => item !== symbol),
    })),
  };
}

/**
 * Moves `symbol` into section `sectionId` at `index` (counted in the list without it), as a
 * drag and drop does.
 */
export function moveSymbol(
  list: Watchlist,
  symbol: SymbolId,
  sectionId: string,
  index: number,
): Watchlist {
  const target = list.sections.find((section) => section.id === sectionId);
  if (!target || !list.sections.some((section) => section.symbols.includes(symbol))) return list;
  const without = removeSymbol(list, symbol);
  return {
    sections: without.sections.map((section) => {
      if (section.id !== sectionId) return section;
      const symbols = [...section.symbols];
      symbols.splice(Math.max(0, Math.min(index, symbols.length)), 0, symbol);
      return { ...section, symbols };
    }),
  };
}

/**
 * Adds `symbol` once, at the end of the section holding `near` (the selected row), else of the
 * last section; an empty list gets a Crypto section.
 */
export function addSymbol(list: Watchlist, symbol: SymbolId, near: SymbolId | null): Watchlist {
  const symbols = allSymbols(list);
  if (symbols.includes(symbol) || symbols.length >= MAX_WATCHLIST_SYMBOLS) return list;
  const target =
    (near !== null && list.sections.find((section) => section.symbols.includes(near))) ||
    list.sections.at(-1);
  if (!target) {
    return { sections: [{ id: 'crypto', title: 'Crypto', collapsed: false, symbols: [symbol] }] };
  }
  return {
    sections: list.sections.map((section) =>
      section === target ? { ...section, symbols: [...section.symbols, symbol] } : section,
    ),
  };
}

export function toggleSection(list: Watchlist, sectionId: string): Watchlist {
  return {
    sections: list.sections.map((section) =>
      section.id === sectionId ? { ...section, collapsed: !section.collapsed } : section,
    ),
  };
}

/** Every symbol in order. */
export function allSymbols(list: Watchlist): SymbolId[] {
  return list.sections.flatMap((section) => section.symbols);
}

/** The symbols a person can see: those in open sections, in order. */
export function visibleSymbols(list: Watchlist): SymbolId[] {
  return list.sections.flatMap((section) => (section.collapsed ? [] : section.symbols));
}

/** The visible symbol `step` places from `symbol` (↑ is −1, ↓ is +1), staying at the ends. */
export function neighbor(list: Watchlist, symbol: SymbolId | null, step: number): SymbolId | null {
  const visible = visibleSymbols(list);
  if (visible.length === 0) return null;
  const index = symbol === null ? -1 : visible.indexOf(symbol);
  if (index < 0) return step > 0 ? (visible[0] ?? null) : (visible.at(-1) ?? null);
  return visible[Math.max(0, Math.min(visible.length - 1, index + step))] ?? null;
}
