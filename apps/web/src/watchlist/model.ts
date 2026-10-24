import {
  MAX_WATCHLIST_SECTIONS,
  MAX_WATCHLIST_SYMBOLS,
  type SymbolId,
  type Watchlist,
  type WatchlistSection,
} from '@tradingnerd/core';

/** Edits to a watchlist, as pure functions: each returns a new list, or the same one if nothing changed. */

/** Removes the symbols given, wherever they are, as Delete on a selection does. */
export function removeSymbols(list: Watchlist, symbols: Iterable<SymbolId>): Watchlist {
  const gone = new Set(symbols);
  if (!list.sections.some((section) => section.symbols.some((symbol) => gone.has(symbol)))) {
    return list;
  }
  return {
    ...list,
    sections: list.sections.map((section) => ({
      ...section,
      symbols: section.symbols.filter((symbol) => !gone.has(symbol)),
    })),
  };
}

export function removeSymbol(list: Watchlist, symbol: SymbolId): Watchlist {
  return removeSymbols(list, [symbol]);
}

const sameSymbols = (a: readonly SymbolId[], b: readonly SymbolId[] | undefined) =>
  b !== undefined && a.length === b.length && a.every((symbol, i) => symbol === b[i]);

/**
 * Moves `symbols` into section `sectionId` at `index` (counted in the section without them), as
 * a drag and drop does: several move together, in their order in the list. Dropped where they
 * were, nothing changes.
 */
export function moveSymbols(
  list: Watchlist,
  symbols: Iterable<SymbolId>,
  sectionId: string,
  index: number,
): Watchlist {
  const wanted = new Set(symbols);
  const moving = allSymbols(list).filter((symbol) => wanted.has(symbol));
  if (moving.length === 0 || !list.sections.some((section) => section.id === sectionId)) {
    return list;
  }
  const sections = removeSymbols(list, moving).sections.map((section) => {
    if (section.id !== sectionId) return section;
    const next = [...section.symbols];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, ...moving);
    return { ...section, symbols: next };
  });
  return sections.every((section, i) => sameSymbols(section.symbols, list.sections[i]?.symbols))
    ? list
    : { ...list, sections };
}

/** Moves one symbol, as moveSymbols. */
export function moveSymbol(
  list: Watchlist,
  symbol: SymbolId,
  sectionId: string,
  index: number,
): Watchlist {
  return moveSymbols(list, [symbol], sectionId, index);
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
    ...list,
    sections: list.sections.map((section) =>
      section === target ? { ...section, symbols: [...section.symbols, symbol] } : section,
    ),
  };
}

/**
 * Adds `symbol` right after `after` (its section, the next place), as TradingView's "Add symbol"
 * on a row's menu does; without `after` in the list, as addSymbol.
 */
export function insertSymbol(list: Watchlist, symbol: SymbolId, after: SymbolId): Watchlist {
  const symbols = allSymbols(list);
  if (symbols.includes(symbol) || symbols.length >= MAX_WATCHLIST_SYMBOLS) return list;
  const host = list.sections.find((section) => section.symbols.includes(after));
  if (!host) return addSymbol(list, symbol, null);
  return {
    ...list,
    sections: list.sections.map((section) => {
      if (section !== host) return section;
      const next = [...section.symbols];
      next.splice(next.indexOf(after) + 1, 0, symbol);
      return { ...section, symbols: next };
    }),
  };
}

/**
 * A new section above `symbol`, as TradingView's "Add section" makes one: it takes `symbol` and
 * the rows after it in its section, and is named "Section 1", "Section 2"… Returns its id too.
 */
export function addSection(list: Watchlist, symbol: SymbolId): { list: Watchlist; id: string } {
  const host = list.sections.find((section) => section.symbols.includes(symbol));
  if (!host) return { list, id: '' };
  const ids = new Set(list.sections.map((section) => section.id));
  const titles = new Set(list.sections.map((section) => section.title.toLowerCase()));
  let n = 1;
  while (ids.has(`section-${n}`) || titles.has(`section ${n}`)) n++;
  const at = host.symbols.indexOf(symbol);
  const added = {
    id: `section-${n}`,
    title: `Section ${n}`,
    collapsed: false,
    symbols: host.symbols.slice(at),
  };
  const sections = list.sections.flatMap((section) =>
    section === host ? [{ ...section, symbols: section.symbols.slice(0, at) }, added] : [section],
  );
  return { list: { ...list, sections }, id: added.id };
}

/** A new, empty section at the top ("Add section" with no row to put it above). */
export function addTopSection(list: Watchlist): { list: Watchlist; id: string } {
  const ids = new Set(list.sections.map((section) => section.id));
  const titles = new Set(list.sections.map((section) => section.title.toLowerCase()));
  let n = 1;
  while (ids.has(`section-${n}`) || titles.has(`section ${n}`)) n++;
  const added = { id: `section-${n}`, title: `Section ${n}`, collapsed: false, symbols: [] };
  return { list: { ...list, sections: [added, ...list.sections] }, id: added.id };
}

/** A section's new name; an empty one keeps the old. */
export function renameSection(list: Watchlist, sectionId: string, title: string): Watchlist {
  const name = title.trim().slice(0, 64);
  const target = list.sections.find((section) => section.id === sectionId);
  if (!target || name === '' || name === target.title) return list;
  return {
    ...list,
    sections: list.sections.map((section) =>
      section === target ? { ...section, title: name } : section,
    ),
  };
}

/**
 * Deletes a section but keeps its symbols, as TradingView's trash on a section's header does:
 * TradingView's list is one line of symbols with "###" dividers, so they join the end of the
 * section above (opened, so they stay in sight), or, from the first section, stay at the top
 * with no header. An empty section just goes. A section without a header has none to delete,
 * and a folded one can't be deleted, as on TradingView.
 */
export function removeSection(list: Watchlist, sectionId: string): Watchlist {
  const at = list.sections.findIndex((section) => section.id === sectionId);
  const target = list.sections[at];
  if (!target || target.title === '' || target.collapsed) return list;
  const sections = [...list.sections];
  const above = sections[at - 1];
  if (target.symbols.length === 0) {
    sections.splice(at, 1);
  } else if (above) {
    sections.splice(at - 1, 2, {
      ...above,
      collapsed: false,
      symbols: [...above.symbols, ...target.symbols],
    });
  } else {
    // With any symbols already headerless below it, so the list keeps one such group.
    const next = sections[1];
    const join = next !== undefined && next.title === '';
    sections.splice(0, join ? 2 : 1, {
      ...target,
      title: '',
      collapsed: false,
      symbols: join ? [...target.symbols, ...next.symbols] : target.symbols,
    });
  }
  return { ...list, sections };
}

/** A row the list shows: a symbol's, or a section's header. */
export type ListItem = { symbol: SymbolId } | { section: string };

export const sameItem = (a: ListItem, b: ListItem) =>
  'symbol' in a
    ? 'symbol' in b && a.symbol === b.symbol
    : 'section' in b && a.section === b.section;

/** The rows a person sees, top to bottom: the headers, and the symbols of open sections. */
export function visibleItems(list: Watchlist): ListItem[] {
  return list.sections.flatMap((section) => [
    ...(section.title === '' ? [] : [{ section: section.id }]),
    ...(section.collapsed ? [] : section.symbols.map((symbol) => ({ symbol }))),
  ]);
}

/** The row shown after `item`; null at the end. */
export function nextItem(list: Watchlist, item: ListItem): ListItem | null {
  const items = visibleItems(list);
  const at = items.findIndex((other) => sameItem(other, item));
  return at < 0 ? null : (items[at + 1] ?? null);
}

/**
 * Where the line for a drop above `slot` (null: at the end) is drawn, as TradingView draws it:
 * on the line under the row above, or over `slot` when nothing is above it.
 */
export function dropLine(
  list: Watchlist,
  slot: ListItem | null,
): { item: ListItem; edge: 'before' | 'after' } | null {
  const items = visibleItems(list);
  const at = slot === null ? items.length : items.findIndex((item) => sameItem(item, slot));
  if (at < 0) return null;
  const above = items[at - 1];
  if (above) return { item: above, edge: 'after' };
  const first = items[at];
  return first ? { item: first, edge: 'before' } : null;
}

/** TradingView's list: one line of symbols, each section's header a divider in it. */
type Line = ({ header: WatchlistSection } | { symbol: SymbolId })[];

function toLine(list: Watchlist): Line {
  return list.sections.flatMap((section) => [
    ...(section.title === '' ? [] : [{ header: section }]),
    ...section.symbols.map((symbol) => ({ symbol })),
  ]);
}

/** Sections again from the line: symbols above the first header make a group with no header. */
function fromLine(line: Line, topId: string): WatchlistSection[] {
  const sections: WatchlistSection[] = [];
  for (const item of line) {
    if ('header' in item) {
      sections.push({ ...item.header, symbols: [] });
      continue;
    }
    if (sections.length === 0) {
      sections.push({ id: topId, title: '', collapsed: false, symbols: [] });
    }
    sections.at(-1)?.symbols.push(item.symbol);
  }
  return sections;
}

/** The id of the symbols with no header: theirs if they're there, else a new one. */
function topId(list: Watchlist): string {
  const first = list.sections[0];
  if (first?.title === '') return first.id;
  const ids = new Set(list.sections.map((section) => section.id));
  let id = 'top';
  for (let n = 2; ids.has(id); n++) id = `top-${n}`;
  return id;
}

/**
 * Moves an open section's header alone, as TradingView does: the rows stay where they are, the
 * symbols below the header's new place (up to the next header) become its own, and the ones it
 * leaves join the section above (opened, so they stay in sight) or stay at the top with no
 * header. It lands above `before` (a symbol of an open section, or a header), or at the end for
 * null. A folded section moves whole, with moveSection.
 */
export function moveSectionHeader(
  list: Watchlist,
  sectionId: string,
  before: ListItem | null,
): Watchlist {
  const target = list.sections.find((section) => section.id === sectionId);
  if (!target || target.title === '' || target.collapsed) return list;
  if (before && 'symbol' in before) {
    const host = list.sections.find((section) => section.symbols.includes(before.symbol));
    if (!host || host.collapsed) return list;
  }
  const line = toLine(list);
  const from = line.findIndex((item) => 'header' in item && item.header === target);
  const [header] = line.splice(from, 1);
  const to =
    before === null
      ? line.length
      : line.findIndex((item) =>
          'symbol' in before
            ? 'symbol' in item && item.symbol === before.symbol
            : 'header' in item && item.header.id === before.section,
        );
  // Above itself, or above its own first row: where it is.
  if (!header || to < 0 || to === from) return list;
  line.splice(to, 0, header);
  const sections = fromLine(line, topId(list));
  if (sections.length > MAX_WATCHLIST_SECTIONS) return list;
  const left = new Set(target.symbols);
  return {
    ...list,
    sections: sections.map((section) =>
      section.collapsed && section.symbols.some((symbol) => left.has(symbol))
        ? { ...section, collapsed: false }
        : section,
    ),
  };
}

/**
 * Moves a whole section, its symbols with it, as TradingView moves a folded one: above the
 * section `before`, or to the end for null. Never above the symbols with no header, which would
 * take them in.
 */
export function moveSection(list: Watchlist, sectionId: string, before: string | null): Watchlist {
  const target = list.sections.find((section) => section.id === sectionId);
  if (!target || target.title === '' || before === sectionId) return list;
  const rest = list.sections.filter((section) => section !== target);
  const at = before === null ? rest.length : rest.findIndex((section) => section.id === before);
  if (at < 0 || rest[at]?.title === '') return list;
  const sections = [...rest.slice(0, at), target, ...rest.slice(at)];
  return sections.every((section, i) => section === list.sections[i])
    ? list
    : { ...list, sections };
}

export function toggleSection(list: Watchlist, sectionId: string): Watchlist {
  return {
    ...list,
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

/**
 * The visible symbols from `from` to `to`, both included, top to bottom: a Shift range, across
 * sections. Just `to` when `from` isn't shown.
 */
export function rangeOf(list: Watchlist, from: SymbolId, to: SymbolId): SymbolId[] {
  const visible = visibleSymbols(list);
  const [a, b] = [visible.indexOf(from), visible.indexOf(to)];
  if (b < 0) return [];
  if (a < 0) return [to];
  return visible.slice(Math.min(a, b), Math.max(a, b) + 1);
}
