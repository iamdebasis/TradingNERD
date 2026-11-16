import type { CurrencyLeg } from '@tradingnerd/pine';

/*
 * Currency conversion for scripts' requests (request.currency_rate(), `currency =`), in a module
 * of its own with nothing of the page in it: the chart's loader and each script's worker
 * (scriptWorker.ts) use the same rule.
 */

/**
 * How a currency converts into the US dollar: a pair we have, read as its price or its inverse
 * (provisional, docs/SPEC.md §11: TradingView takes "the most popular exchange"'s pair; ours are
 * Kraken's, its fiat and stablecoin pairs against the dollar, until rates are compared).
 */
const IN_USD: Readonly<Record<string, CurrencyLeg>> = {
  USDT: { symbol: 'KRAKEN:USDTUSD', invert: false },
  USDC: { symbol: 'KRAKEN:USDCUSD', invert: false },
  DAI: { symbol: 'KRAKEN:DAIUSD', invert: false },
  EUR: { symbol: 'KRAKEN:EURUSD', invert: false },
  GBP: { symbol: 'KRAKEN:GBPUSD', invert: false },
  AUD: { symbol: 'KRAKEN:AUDUSD', invert: false },
  JPY: { symbol: 'KRAKEN:USDJPY', invert: true },
  CAD: { symbol: 'KRAKEN:USDCAD', invert: true },
  CHF: { symbol: 'KRAKEN:USDCHF', invert: true },
  BTC: { symbol: 'KRAKEN:XBTUSD', invert: false },
  ETH: { symbol: 'KRAKEN:ETHUSD', invert: false },
};

/** The pairs converting `from` into `to`: through the dollar when neither is it; null for none. */
export function currencyPath(from: string, to: string): CurrencyLeg[] | null {
  if (from === to) return [];
  const out: CurrencyLeg[] = [];
  if (from !== 'USD') {
    const leg = IN_USD[from];
    if (!leg) return null;
    out.push(leg);
  }
  if (to !== 'USD') {
    const leg = IN_USD[to];
    if (!leg) return null;
    out.push({ symbol: leg.symbol, invert: !leg.invert });
  }
  return out;
}
