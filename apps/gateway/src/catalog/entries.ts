import type { CatalogEntry } from '@tradingnerd/core';
import type { CatalogPair, CatalogSnapshot } from './types.ts';

/** Kraken's own codes for the assets everyone else calls BTC and DOGE. */
const ASSET_ALIASES: Readonly<Record<string, string>> = { XBT: 'BTC', XDG: 'DOGE' };

export const normalizeAsset = (code: string): string => ASSET_ALIASES[code] ?? code;

/** Assets worth one US dollar: the dollar itself and dollar stablecoins. */
export const DOLLARS: ReadonlySet<string> = new Set([
  'USD',
  'USDT',
  'USDC',
  'FDUSD',
  'USD1',
  'U',
  'TUSD',
  'DAI',
  'PYUSD',
  'USDE',
  'RLUSD',
  'USDP',
  'USDG',
  'USDS',
  'BUSD',
]);

/**
 * Dollars per unit of each asset an exchange prices pairs in, from that exchange's own most
 * traded pair against a dollar: BTC from BTCUSDT, TRY from USDTTRY (inverted).
 */
export function usdRates(pairs: readonly CatalogPair[]): Map<string, number> {
  const best = new Map<string, { rate: number; volume: number }>();
  const offer = (asset: string, rate: number, volume: number) => {
    const current = best.get(asset);
    if (!current || volume > current.volume) best.set(asset, { rate, volume });
  };
  for (const pair of pairs) {
    if (!(pair.last > 0)) continue;
    const base = normalizeAsset(pair.base);
    const quote = normalizeAsset(pair.quote);
    if (DOLLARS.has(quote) && !DOLLARS.has(base)) offer(base, pair.last, pair.quoteVolume);
    else if (DOLLARS.has(base) && !DOLLARS.has(quote)) {
      offer(quote, 1 / pair.last, pair.quoteVolume / pair.last);
    }
  }
  const rates = new Map<string, number>([...DOLLARS].map((code) => [code, 1]));
  for (const [asset, { rate }] of best) rates.set(asset, rate);
  return rates;
}

/**
 * Asset names from every exchange that publishes them, the first list first (Binance's, whose
 * names TradingView shows: "TetherUS"). A name that only repeats the code gives way to a real
 * one ("USD" → Coinbase's "US Dollar").
 */
export function mergeNames(
  lists: readonly Readonly<Record<string, string>>[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const list of lists) {
    for (const [code, name] of Object.entries(list)) {
      const asset = normalizeAsset(code);
      const known = names.get(asset);
      const bare = (text: string) => text.toUpperCase() === asset;
      if (!known || (bare(known) && !bare(name))) names.set(asset, name);
    }
  }
  return names;
}

/**
 * The searchable catalog: each exchange's pairs with Kraken's codes normalized, descriptions
 * built from the shared names ("XRP / TetherUS") and 24 h volume in dollars, for ranking.
 */
export function buildEntries(
  exchanges: readonly { id: string; snapshot: CatalogSnapshot }[],
  live: ReadonlySet<string>,
  names: ReadonlyMap<string, string> = mergeNames(exchanges.map(({ snapshot }) => snapshot.names)),
): CatalogEntry[] {
  const nameOf = (code: string) => names.get(code) ?? code;
  const entries: CatalogEntry[] = [];
  for (const { id, snapshot } of exchanges) {
    const rates = usdRates(snapshot.pairs);
    const seen = new Set<string>();
    for (const pair of snapshot.pairs) {
      if (seen.has(pair.ticker)) continue; // one listing per ticker and exchange
      seen.add(pair.ticker);
      const base = normalizeAsset(pair.base);
      const quote = normalizeAsset(pair.quote);
      entries.push({
        exchange: id,
        ticker: pair.ticker,
        base,
        quote,
        description: `${nameOf(base)} / ${nameOf(quote)}`,
        volumeUsd: pair.quoteVolume * (rates.get(quote) ?? 0),
        live: live.has(id),
      });
    }
  }
  return entries;
}
