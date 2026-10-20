import type { SymbolKind } from '@tradingnerd/core';

/**
 * Every US-listed stock and fund, from Nasdaq's official symbol directory (nasdaqtrader.com):
 * nasdaqlisted.txt for Nasdaq's own listings and otherlisted.txt for the other exchanges',
 * refreshed through each trading day. Tickers are written as TradingView writes them: class
 * shares with a dot (BRK.B), preferreds, warrants, units and rights after a slash (JPM/PD,
 * ACHR/W).
 */
export interface UsListing {
  /** TradingView's exchange code: NASDAQ, NYSE, AMEX (NYSE American and NYSE Arca), CBOE. */
  exchange: string;
  /** Where it is listed: "NASDAQ", "NYSE", "NYSE Arca", "NYSE American", "Cboe BZX". */
  venue: string;
  /** TradingView's ticker: "AAPL", "BRK.B", "JPM/PD". */
  ticker: string;
  /** The issuer's common ticker: "JPM" for JPM/PD, "AACI" for the warrant AACIW. */
  root: string;
  /** The symbol market data knows it by, where known (Alpaca's for preferreds isn't). */
  dataSymbol: string | null;
  /** "Apple Inc.", "SPDR S&P 500 ETF Trust" */
  name: string;
  kind: SymbolKind;
}

/**
 * otherlisted.txt's exchange codes. TradingView files NYSE Arca under AMEX too ("AMEX:SPY").
 * IEX and the Texas Stock Exchange (code F, new in 2026, not yet in Nasdaq's definitions) have
 * codes of our own until TradingView's are confirmed.
 */
const OTHER_EXCHANGES: Readonly<Record<string, { exchange: string; venue: string }>> = {
  N: { exchange: 'NYSE', venue: 'NYSE' },
  A: { exchange: 'AMEX', venue: 'NYSE American' },
  P: { exchange: 'AMEX', venue: 'NYSE Arca' },
  Z: { exchange: 'CBOE', venue: 'Cboe BZX' },
  V: { exchange: 'IEX', venue: 'IEX' },
  F: { exchange: 'TXSE', venue: 'Texas Stock Exchange' },
};

/** Every exchange code a US listing can have, for symbol ids and the search's source filter. */
export const US_EXCHANGES: readonly { id: string; name: string }[] = [
  { id: 'NASDAQ', name: 'NASDAQ' },
  { id: 'NYSE', name: 'NYSE' },
  { id: 'AMEX', name: 'NYSE Arca & NYSE American' },
  { id: 'CBOE', name: 'Cboe BZX' },
  { id: 'IEX', name: 'IEX' },
  { id: 'TXSE', name: 'Texas Stock Exchange' },
];

/** The kind of security a name describes (ETFs and $-preferreds are flagged by the file). */
export function kindFromName(name: string): SymbolKind {
  if (/\bpreferred\b|\bpfd\b/i.test(name)) return 'preferred';
  if (/\bwarrants?\b/i.test(name)) return 'warrant';
  if (/\brights?\b/i.test(name)) return 'right';
  if (/\bunits?\b/i.test(name) && !/common units?|limited partner/i.test(name)) return 'unit';
  if (/american depositary|depositary receipts?|\bADS\b|\bADR\b/i.test(name)) return 'dr';
  if (/\bnotes? due\b|\bsenior notes\b|\bdebentures?\b|% notes\b/i.test(name)) return 'note';
  return 'stock';
}

/** A security name with its spacing tidied. */
const tidy = (name: string) => name.replace(/\s+/g, ' ').trim();

/**
 * A share's name without the share-class boilerplate TradingView leaves out:
 * "Apple Inc. - Common Stock" → "Apple Inc.", "Alphabet Inc. - Class A Common Stock" →
 * "Alphabet Inc. Class A", "Energy Transfer LP Common Units" → "Energy Transfer LP",
 * "Alibaba Group Holding Limited American Depositary Shares each representing …" → "Alibaba
 * Group Holding Limited". Other securities keep their full names.
 */
export function cleanName(name: string, kind: SymbolKind = 'stock'): string {
  if (kind !== 'stock' && kind !== 'dr') return tidy(name);
  return tidy(name)
    .replace(/\s*\b(New )?(Common (Stock|Shares|Units?)|Ordinary Shares?)\b.*$/i, '')
    .replace(/\s*\b(American Depositary (Shares?|Receipts?)|ADS|ADR)\b.*$/i, '')
    .replace(/\s+-\s+/g, ' ')
    .replace(/\s*-$/, '')
    .trim();
}

/** Parses one directory file's rows: '|'-separated, a header, and a "File Creation Time" row. */
function rowsOf(text: string, columns: number): string[][] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.at(-1)?.startsWith('File Creation Time')) {
    throw new Error('The symbol directory file is incomplete');
  }
  return lines
    .slice(1, -1)
    .map((line) => line.split('|'))
    .filter((row) => row.length >= columns);
}

/** nasdaqlisted.txt: Symbol | Security Name | Market Category | Test Issue | … | ETF | … */
export function parseNasdaqListed(text: string): UsListing[] {
  const listings: UsListing[] = [];
  for (const [symbol = '', name = '', , testIssue, , , etf] of rowsOf(text, 7)) {
    if (testIssue === 'Y' || !/^[A-Z]{1,5}$/.test(symbol)) continue;
    const kind: SymbolKind = etf === 'Y' ? 'etf' : kindFromName(name);
    // A fifth letter marks warrants, units and rights of the four-letter issuer.
    const suffixed =
      symbol.length === 5 && ['warrant', 'unit', 'right', 'preferred'].includes(kind);
    listings.push({
      exchange: 'NASDAQ',
      venue: 'NASDAQ',
      ticker: symbol,
      root: suffixed ? symbol.slice(0, 4) : symbol,
      dataSymbol: symbol,
      name: cleanName(name, kind),
      kind,
    });
  }
  return listings;
}

/** otherlisted.txt: ACT Symbol | Security Name | Exchange | CQS Symbol | ETF | … | Test Issue | … */
export function parseOtherListed(
  text: string,
  onUnknownExchange?: (code: string) => void,
): UsListing[] {
  const listings: UsListing[] = [];
  const unknown = new Set<string>();
  for (const [act = '', name = '', code = '', , etf, , testIssue] of rowsOf(text, 7)) {
    if (testIssue === 'Y') continue;
    const where = OTHER_EXCHANGES[code];
    if (!where) {
      unknown.add(code);
      continue;
    }
    const listing = tickerOf(act, name, etf === 'Y');
    if (listing) listings.push({ ...where, ...listing });
  }
  for (const code of unknown) onUnknownExchange?.(code);
  return listings;
}

/** An ACT symbol ("BRK.B", "JPM$D", "ACHR.W") as TradingView writes it, with its kind. */
function tickerOf(
  act: string,
  name: string,
  etf: boolean,
): Pick<UsListing, 'ticker' | 'root' | 'dataSymbol' | 'name' | 'kind'> | null {
  const match = /^([A-Z]{1,6})(?:(\$)([A-Z]{0,2})|\.([A-Z]{1,2}))?$/.exec(act);
  if (!match) return null;
  const [, root = '', dollar, series = '', suffix] = match;
  if (dollar) {
    // Preferreds: "JPM$D" is TradingView's JPM/PD (series DD).
    return {
      ticker: `${root}/P${series}`,
      root,
      dataSymbol: null,
      name: tidy(name),
      kind: 'preferred',
    };
  }
  if (suffix) {
    const slashed: Record<string, SymbolKind> = { W: 'warrant', U: 'unit', R: 'right' };
    const kind = slashed[suffix];
    if (kind)
      return { ticker: `${root}/${suffix}`, root, dataSymbol: null, name: tidy(name), kind };
    // A share class keeps its dot: BRK.B, which market data knows by the same name.
    const classKind = etf ? 'etf' : kindFromName(name);
    return {
      ticker: `${root}.${suffix}`,
      root,
      dataSymbol: `${root}.${suffix}`,
      name: cleanName(name, classKind),
      kind: classKind,
    };
  }
  const kind = etf ? 'etf' : kindFromName(name);
  return {
    ticker: root,
    root,
    dataSymbol: root,
    name: cleanName(name, kind),
    kind,
  };
}
