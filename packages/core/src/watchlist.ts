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

export const MAX_WATCHLIST_SECTIONS = 200;
/** TradingView's own limit for one list. */
export const MAX_WATCHLIST_SYMBOLS = 1_000;
export const MAX_SECTION_TITLE = 64;
/** The longest symbol a list keeps (TradingView's spreads can be long). */
export const MAX_WATCHLIST_SYMBOL = 128;
const MAX_ID = 32;

/**
 * A watchlist entry as TradingView writes it, "EXCHANGE:SYMBOL": in our canonical form when it
 * has the shape of the symbols we chart ("binance:xrpusdt" → "BINANCE:XRPUSDT"), or else as
 * written, so a list from TradingView keeps symbols we don't have ("GLASSNODE:BTC_HASHRATE",
 * "CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD", "CME_MINI:ES1!"). Null for anything a list can't hold:
 * no exchange prefix, too long, a section marker, or a comma or control character (they'd
 * break TradingView's file format).
 */
export function parseWatchlistSymbol(value: unknown): SymbolId | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_WATCHLIST_SYMBOL || text.startsWith('###')) {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's refused
  if (/[,\u0000-\u001f\u007f]/.test(text) || !/^[^:\s]+:\S/.test(text)) return null;
  const parsed = parseSymbolId(text);
  return parsed ? `${parsed.exchange}:${parsed.ticker}` : text;
}

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
 * symbol ids (parseWatchlistSymbol), each symbol at most once (its first place wins), trimmed
 * titles, unique ids. A section may be untitled: TradingView's symbols above its first section.
 * Null if it isn't a watchlist at all or exceeds the limits. (Flags are kept apart: flags.ts.)
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
    if (typeof title !== 'string' || title.trim().length > MAX_SECTION_TITLE) return null;
    if (typeof collapsed !== 'boolean' || !Array.isArray(symbols)) return null;
    total += symbols.length;
    if (total > MAX_WATCHLIST_SYMBOLS) return null;
    const list: SymbolId[] = [];
    for (const symbol of symbols) {
      const canonical = parseWatchlistSymbol(symbol);
      if (!canonical) return null;
      if (seenSymbols.has(canonical)) continue;
      seenSymbols.add(canonical);
      list.push(canonical);
    }
    seenIds.add(id);
    parsed.push({ id, title: title.trim(), collapsed, symbols: list });
  }
  return { sections: parsed };
}
