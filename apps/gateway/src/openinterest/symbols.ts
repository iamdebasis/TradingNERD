/**
 * TradingView's open interest symbols (docs/SPEC.md §6.18, milestone P4): a perpetual's ticker
 * with `_OI` after it, "BINANCE:BTCUSDT.P_OI", as TradingView's symbol pages and the scripts
 * that read them name them; Binance's older names too ("BTCUSDTPERP_OI", and "BTCPERP_OI" for the
 * coin-margined one), which scripts written before TradingView renamed its perpetuals still use.
 */

/** The exchanges whose perpetuals' open interest we serve. */
export const OI_EXCHANGES = ['BINANCE', 'BYBIT', 'OKX'] as const;
export type OiExchange = (typeof OI_EXCHANGES)[number];

export const OI_SUFFIX = '_OI';

/**
 * What an exchange counts open interest in, as its own API reports it: the coin (Binance's and
 * Bybit's stablecoin-margined perpetuals), US dollars (Bybit's coin-margined ones) or contracts
 * (Binance's coin-margined ones, $100 or $10 each; OKX's). TradingView's Help Center: values
 * "may be presented in base currency, quote currency, or contracts, depending on the exchange
 * and crypto derivative"; which it shows for each isn't documented (provisional, §11).
 */
export type OiUnit = 'coin' | 'usd' | 'contracts';

export interface OiContract {
  exchange: OiExchange;
  /** TradingView's ticker for it: "BTCUSDT.P_OI". */
  ticker: string;
  /** The pair: "BTCUSDT", or "BTCUSD" for a coin-margined perpetual. */
  pair: string;
  base: string;
  /** "USDT", "USDC", "FDUSD" or "USD". */
  quote: string;
  /** Margined in a stablecoin (linear) or in the coin itself (inverse). */
  margin: 'linear' | 'inverse';
  /** The exchange's own id for the perpetual: "BTCUSDT", "BTCUSD_PERP", "BTC-USDT-SWAP". */
  providerId: string;
  unit: OiUnit;
}

/** Quotes a perpetual's pair can end in, the longest first so "FDUSD" isn't read as "USD". */
const QUOTES = ['FDUSD', 'USDT', 'USDC', 'BUSD', 'USD'] as const;
const BASE = /^[A-Z0-9]{1,20}$/;

/** Whether a ticker is an open interest symbol's. */
export const isOiTicker = (ticker: string): boolean => ticker.toUpperCase().endsWith(OI_SUFFIX);

/** An open interest ticker on one of our exchanges, or null when it isn't one we know. */
export function parseOiTicker(exchange: string, ticker: string): OiContract | null {
  const upper = ticker.toUpperCase();
  if (!upper.endsWith(OI_SUFFIX) || !(OI_EXCHANGES as readonly string[]).includes(exchange)) {
    return null;
  }
  const venue = exchange as OiExchange;
  const perpetual = upper.slice(0, -OI_SUFFIX.length);
  let pair: string | null = null;
  if (perpetual.endsWith('.P')) pair = perpetual.slice(0, -2);
  else if (venue === 'BINANCE' && perpetual.endsWith('PERP')) {
    // Binance's names before TradingView's ".P": "BTCUSDTPERP" for USDⓈ-M, "BTCPERP" for COIN-M.
    const rest = perpetual.slice(0, -4);
    pair = QUOTES.some((quote) => rest.endsWith(quote) && rest.length > quote.length)
      ? rest
      : `${rest}USD`;
  }
  if (!pair) return null;
  const quote = QUOTES.find((q) => pair.endsWith(q) && pair.length > q.length);
  if (!quote) return null;
  const base = pair.slice(0, -quote.length);
  if (!BASE.test(base)) return null;
  const margin = quote === 'USD' ? 'inverse' : 'linear';
  const contract = (providerId: string, unit: OiUnit): OiContract => ({
    exchange: venue,
    ticker: `${pair}.P${OI_SUFFIX}`,
    pair,
    base,
    quote,
    margin,
    providerId,
    unit,
  });
  switch (venue) {
    case 'BINANCE':
      return margin === 'linear'
        ? contract(pair, 'coin')
        : contract(`${base}USD_PERP`, 'contracts');
    case 'BYBIT':
      // Bybit's USDC perpetuals are its "BTCPERP"; its coin-margined ones count dollars.
      if (margin === 'inverse') return contract(`${base}USD`, 'usd');
      if (quote === 'USDC') return contract(`${base}PERP`, 'coin');
      return quote === 'USDT' ? contract(pair, 'coin') : null;
    case 'OKX':
      if (quote !== 'USDT' && quote !== 'USDC' && quote !== 'USD') return null;
      return contract(`${base}-${quote}-SWAP`, 'contracts');
  }
}

/** Decimals an open interest is written with, by what it counts (the exchanges' own steps). */
export function unitDecimals(contract: OiContract): number {
  if (contract.unit === 'coin') return 3;
  if (contract.unit === 'usd') return 0;
  return contract.exchange === 'OKX' ? 2 : 0;
}
