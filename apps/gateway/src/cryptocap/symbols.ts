import { CRYPTOCAP } from '@tradingnerd/core';

export { CRYPTOCAP };

/** The base of a CRYPTOCAP symbol that isn't one coin's: its icon is CRYPTOCAP's badge. */
export const CRYPTOCAP_BASE = CRYPTOCAP;

/** Market caps of many coins together. */
export const COMPOSITES = [
  'TOTAL',
  'TOTAL2',
  'TOTAL3',
  'OTHERS',
  'TOTALES',
  'TOTAL2ES',
  'TOTAL3ES',
  'TOTALE50',
  'TOTALE100',
  'STABLE.C',
] as const;
export type CompositeName = (typeof COMPOSITES)[number];

/** A composite against Bitcoin's market cap. */
export const RATIOS = ['OTHERSBTC', 'TOTAL3ESBTC'] as const;
export type RatioName = (typeof RATIOS)[number];

/** TradingView's names, from its symbol pages (docs/SPEC.md §4.11). */
const COMPOSITE_NAMES: Readonly<Record<CompositeName, string>> = {
  TOTAL: 'Crypto Total Market Cap, $',
  TOTAL2: 'Crypto Total Market Cap Excluding BTC, $',
  TOTAL3: 'Crypto Total Market Cap Excluding BTC and ETH, $',
  OTHERS: 'Crypto Total Market Cap Excluding Top 10, $',
  TOTALES: 'Crypto Total Market Cap Excluding Stablecoins, $',
  TOTAL2ES: 'Crypto Total Market Cap Excluding BTC and Stablecoins, $',
  TOTAL3ES: 'Crypto Total Market Cap Excluding BTC, ETH and Stablecoins, $',
  TOTALE50: 'Crypto Total Market Cap Excluding Top 50, $',
  TOTALE100: 'Crypto Total Market Cap Excluding Top 100, $',
  'STABLE.C': 'Crypto Stablecoins Market Cap, $',
};

const RATIO_NAMES: Readonly<Record<RatioName, string>> = {
  OTHERSBTC: 'Ratio Total Market Cap Excluding Top 10 to BTC',
  TOTAL3ESBTC: 'Ratio Total Market Cap Excluding BTC, ETH and Stablecoins to BTC',
};

/** What a ratio divides by Bitcoin's market cap. */
export const RATIO_OF: Readonly<Record<RatioName, CompositeName>> = {
  OTHERSBTC: 'OTHERS',
  TOTAL3ESBTC: 'TOTAL3ES',
};

/** A market cap: of many coins (a composite) or of one coin, by its symbol ("XRP"). */
export type CapSeries =
  | { kind: 'composite'; name: CompositeName }
  | { kind: 'coin'; symbol: string };

/** What a CRYPTOCAP ticker stands for. */
export type CapTicker =
  | CapSeries
  | { kind: 'ratio'; name: RatioName }
  /** `of` against TOTAL, in percent: BTC.D, OTHERS.D. */
  | { kind: 'dominance'; of: CapSeries };

/** Coin symbols as tickers: letters and digits ("1INCH", "0G"). */
const COIN_SYMBOL = /^[A-Z0-9]{1,20}$/;

const isComposite = (text: string): text is CompositeName =>
  (COMPOSITES as readonly string[]).includes(text);
const isRatio = (text: string): text is RatioName => (RATIOS as readonly string[]).includes(text);

/** A market cap's ticker: TOTAL2, or a coin's symbol. Composite names win over coins'. */
function parseSeries(text: string): CapSeries | null {
  if (isComposite(text)) return { kind: 'composite', name: text };
  return COIN_SYMBOL.test(text) && !isRatio(text) ? { kind: 'coin', symbol: text } : null;
}

/**
 * Reads a CRYPTOCAP ticker: TOTAL2, STABLE.C, OTHERSBTC, a coin's symbol (XRP), or any of those
 * but a ratio with ".D" for its dominance (BTC.D, OTHERS.D). TOTAL.D would always be 100%, so it
 * isn't one.
 */
export function parseCapTicker(ticker: string): CapTicker | null {
  const text = ticker.trim().toUpperCase();
  if (isRatio(text)) return { kind: 'ratio', name: text };
  if (text.endsWith('.D')) {
    const of = parseSeries(text.slice(0, -2));
    if (!of || (of.kind === 'composite' && of.name === 'TOTAL')) return null;
    return { kind: 'dominance', of };
  }
  return parseSeries(text);
}

/** The ticker of a parsed CRYPTOCAP symbol, as TradingView writes it. */
export function capTickerText(ticker: CapTicker): string {
  switch (ticker.kind) {
    case 'composite':
    case 'ratio':
      return ticker.name;
    case 'coin':
      return ticker.symbol;
    case 'dominance':
      return `${capTickerText(ticker.of)}.D`;
  }
}

/**
 * TradingView's description: "Crypto Total Market Cap Excluding BTC, $", "Market Cap BTC, $";
 * a dominance takes its market cap's name without ", $" and adds " Dominance, %".
 */
export function capDescription(ticker: CapTicker): string {
  switch (ticker.kind) {
    case 'composite':
      return COMPOSITE_NAMES[ticker.name];
    case 'coin':
      return `Market Cap ${ticker.symbol}, $`;
    case 'ratio':
      return RATIO_NAMES[ticker.name];
    case 'dominance':
      return `${capDescription(ticker.of).replace(/, \$$/, '')} Dominance, %`;
  }
}
