import { parseSymbolId, type SymbolId } from './market.ts';

/** One collapsible section of the watchlist, e.g. CRYPTO. */
export interface WatchlistSection {
  /** Stable id, for keys and persistence. */
  id: string;
  /** Shown in capitals, as TradingView does. */
  title: string;
  collapsed: boolean;
  /** Symbols in the user's order. */
  symbols: SymbolId[];
}

export interface Watchlist {
  sections: WatchlistSection[];
}

export const MAX_WATCHLIST_SECTIONS = 50;
export const MAX_WATCHLIST_SYMBOLS = 1_000;
const MAX_TITLE = 64;
const MAX_ID = 32;

/**
 * The user's own TradingView watchlist (docs/reference/01-chart-layout.png), on Binance, where
 * other exchanges arrive in M5. XCH isn't listed there and SNT is halted, so they're left out;
 * XRP, the chart's symbol, leads.
 */
export const DEFAULT_WATCHLIST: Watchlist = {
  sections: [
    {
      id: 'crypto',
      title: 'Crypto',
      collapsed: false,
      symbols: [
        'XRP',
        'LINK',
        'BAT',
        'ARB',
        'ZAMA',
        'MANA',
        'DASH',
        'POL',
        'OP',
        'TIA',
        'LDO',
        'STRK',
        'XTZ',
        'VET',
        'TWT',
        'THETA',
        'SHIB',
        'RUNE',
        'PEPE',
        'MINA',
        'KSM',
        'IOTA',
      ].map((base) => `BINANCE:${base}USDT`),
    },
  ],
};

/**
 * A valid watchlist from anything (e.g. a PUT body or a stored file), normalized: canonical
 * symbol ids, each symbol at most once (its first place wins), trimmed titles, unique ids.
 * Null if it isn't a watchlist at all or exceeds the limits.
 */
export function parseWatchlist(value: unknown): Watchlist | null {
  if (typeof value !== 'object' || value === null) return null;
  const { sections } = value as Record<string, unknown>;
  if (!Array.isArray(sections) || sections.length > MAX_WATCHLIST_SECTIONS) return null;
  const seenSymbols = new Set<string>();
  const seenIds = new Set<string>();
  const parsed: WatchlistSection[] = [];
  let total = 0;
  for (const raw of sections) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { id, title, collapsed, symbols } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID || seenIds.has(id)) {
      return null;
    }
    if (typeof title !== 'string' || title.trim().length > MAX_TITLE) return null;
    if (typeof collapsed !== 'boolean' || !Array.isArray(symbols)) return null;
    total += symbols.length;
    if (total > MAX_WATCHLIST_SYMBOLS) return null;
    const list: SymbolId[] = [];
    for (const symbol of symbols) {
      const parsedId = typeof symbol === 'string' ? parseSymbolId(symbol) : null;
      if (!parsedId) return null;
      const canonical = `${parsedId.exchange}:${parsedId.ticker}`;
      if (seenSymbols.has(canonical)) continue;
      seenSymbols.add(canonical);
      list.push(canonical);
    }
    seenIds.add(id);
    parsed.push({ id, title: title.trim(), collapsed, symbols: list });
  }
  return { sections: parsed };
}
