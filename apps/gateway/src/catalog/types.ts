/** One spot pair as an exchange lists it. */
export interface CatalogPair {
  /** TradingView's ticker for it: "XRPUSDT", or Kraken's own short name, "XBTUSD". */
  ticker: string;
  /** Asset codes as the exchange writes them ("XBT" on Kraken). */
  base: string;
  quote: string;
  /** Traded value over 24 h, in the quote asset; 0 when unknown. */
  quoteVolume: number;
  /** Last price, in the quote asset; 0 when unknown. */
  last: number;
}

/** One exchange's pairs, and the asset names it publishes, if any. */
export interface CatalogSnapshot {
  pairs: CatalogPair[];
  /** Asset code → display name: "USD" → "US Dollar". */
  names: Record<string, string>;
}

/** Where the symbol catalog gets an exchange's pairs: its public REST API, with no key. */
export interface CatalogSource {
  /** Exchange code used in symbol ids: "BYBIT". */
  readonly id: string;
  /** "Bybit" */
  readonly name: string;
  fetchCatalog(): Promise<CatalogSnapshot>;
}

export interface CatalogSourceOptions {
  /** Endpoint override, e.g. an unreachable one for offline tests. */
  restUrl?: string | undefined;
  fetch?: typeof fetch;
}
