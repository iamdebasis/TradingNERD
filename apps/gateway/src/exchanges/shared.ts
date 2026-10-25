import {
  type Bar,
  formatResolution,
  parseResolution,
  precisionOf,
  type Resolution,
  type SymbolInfo,
  UTC_ZONE,
} from '@tradingnerd/core';
import type { AssetNames } from '../catalog/names.ts';
import {
  type CandleUpdate,
  type FeedState,
  MarketError,
  type Unsubscribe,
} from '../market/types.ts';
import type { StreamClient, StreamClientOptions } from '../stream/StreamClient.ts';

/** One tradable pair as an exchange adapter knows it. */
export interface Instrument {
  /** TradingView's ticker: "XRPUSDT", Kraken's "XBTUSD". */
  ticker: string;
  /** What the exchange's REST API calls it: "XRP-USDT", Kraken's "XXRPZUSD". */
  restId: string;
  /** What its WebSocket API calls it, where that differs: Kraken's "XRP/USD". */
  streamId: string;
  /** Asset codes, normalized ("XBT" is "BTC"). */
  base: string;
  quote: string;
  tickSize: number;
}

/** How long an exchange's pair list answers symbol lookups before it's fetched again. */
export const INSTRUMENTS_TTL_MS = 12 * 60 * 60_000;

/**
 * An exchange's pairs by ticker, loaded once and kept for 12 hours; shared by symbol lookups
 * and the search catalog, so the list is fetched once for both. An exchange can keep more about
 * each pair than `Instrument` holds (Bitstamp its own description).
 */
export class InstrumentBook<T extends Instrument = Instrument> {
  private readonly load: () => Promise<T[]>;
  private readonly exchangeName: string;
  private cached: { list: Promise<Map<string, T>>; fetchedAt: number } | null = null;
  /** The last list that arrived, for lookups that can't wait. */
  private ready: ReadonlyMap<string, T> = new Map();

  constructor(exchangeName: string, load: () => Promise<T[]>) {
    this.exchangeName = exchangeName;
    this.load = load;
  }

  async get(ticker: string): Promise<T> {
    const instrument = (await this.byTicker()).get(ticker);
    if (!instrument) {
      throw new MarketError('unknown_symbol', `${this.exchangeName} does not list this symbol`);
    }
    return instrument;
  }

  /**
   * An instrument already loaded, for setting up streams synchronously: every feed resolves
   * its symbol before it subscribes.
   */
  loaded(ticker: string): T | undefined {
    return this.ready.get(ticker);
  }

  /** Keeps a list just fetched for the catalog, saving lookups a request. */
  remember(instruments: readonly T[]): void {
    const map = new Map(instruments.map((instrument) => [instrument.ticker, instrument]));
    this.cached = { list: Promise.resolve(map), fetchedAt: Date.now() };
    this.ready = map;
  }

  /** Loads the list ahead of the first lookup (at start), which then needn't wait for it. */
  async prepare(): Promise<void> {
    await this.byTicker().catch(() => {});
  }

  private byTicker(): Promise<Map<string, T>> {
    if (!this.cached) return this.refresh();
    if (Date.now() - this.cached.fetchedAt > INSTRUMENTS_TTL_MS) {
      // An old list still answers while a new one loads, so no lookup waits on the download.
      const stale = this.ready;
      const fresh = this.refresh();
      if (stale.size > 0) return Promise.resolve(new Map(stale));
      return fresh;
    }
    return this.cached.list;
  }

  private refresh(): Promise<Map<string, T>> {
    const list = this.load().then(
      (instruments) => new Map(instruments.map((instrument) => [instrument.ticker, instrument])),
    );
    const entry = { list, fetchedAt: Date.now() };
    this.cached = entry;
    list.then(
      (map) => {
        if (this.cached === entry) this.ready = map;
      },
      () => {
        // A failed load is forgotten, so the next lookup tries again.
        if (this.cached === entry) this.cached = null;
      },
    );
    return list;
  }
}

/** A symbol's details from its instrument, described with the shared asset names. */
export function symbolInfo(
  exchange: { id: string; name: string },
  instrument: Instrument,
  names: AssetNames,
  resolutions: readonly string[],
): SymbolInfo {
  return {
    id: `${exchange.id}:${instrument.ticker}`,
    exchange: exchange.id,
    exchangeName: exchange.name,
    ticker: instrument.ticker,
    base: instrument.base,
    quote: instrument.quote,
    description: names.describe(instrument.base, instrument.quote),
    type: 'spot',
    tickSize: instrument.tickSize,
    pricePrecision: precisionOf(instrument.tickSize),
    resolutions: [...resolutions],
    timezone: UTC_ZONE,
    delayMs: 0,
    hasBook: true,
  };
}

/**
 * The feed state of an exchange that needs several connections (OKX streams candles on one
 * and trades on another): up while every connection in use is up. A connection closing because
 * nothing uses it any more is no outage.
 */
export class CombinedFeed {
  private readonly clients: readonly StreamClient[];

  constructor(clients: readonly StreamClient[]) {
    this.clients = clients;
  }

  isUp(): boolean {
    return this.clients.every((client) => client.isUp() || !client.isInUse());
  }

  onState(listener: (state: FeedState) => void): Unsubscribe {
    const unsubscribes = this.clients.map((client) =>
      client.onState((state) => {
        if (state === 'down') {
          if (client.isInUse()) listener('down');
        } else if (this.isUp()) {
          listener('up');
        }
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close()));
  }
}

/** Spaces an exchange's REST requests at least `intervalMs` apart, in order, under its limit. */
export class RequestPacer {
  private readonly intervalMs: number;
  private next = 0;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

/** How often a polled candle "stream" asks again. */
export const CANDLE_POLL_MS = 30_000;

/**
 * Candle updates made of REST polls, for an interval an exchange doesn't stream (Coinbase
 * streams 5-minute candles only). Each poll takes the latest two bars: the current one keeps
 * volume and extremes exact, and the one before finalizes a bar after it closes.
 */
export function pollCandles(
  fetchLatest: () => Promise<Bar[]>,
  onUpdate: (update: CandleUpdate) => void,
  warn: (message: string) => void,
  intervalMs = CANDLE_POLL_MS,
): Unsubscribe {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    const eventTime = Date.now();
    try {
      const bars = await fetchLatest();
      if (stopped) return;
      for (const bar of bars) onUpdate({ bar, eventTime });
    } catch (error) {
      if (!stopped) warn(`Couldn't refresh the live candle (${String(error)})`);
    }
    if (!stopped) timer = setTimeout(poll, intervalMs);
  };
  // The live bar starts from a REST copy anyway; the first poll can wait a round.
  timer = setTimeout(poll, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * TradingView resolution → an exchange's interval name, for the intervals it serves natively
 * (the gateway resamples the rest). A list, not an object: object keys like "1" and "60"
 * would be reordered ahead of "1S".
 */
export class IntervalTable {
  /** Native resolutions in TradingView notation, shortest first. */
  readonly resolutions: readonly string[];
  readonly native: readonly Resolution[];
  private readonly exchangeName: string;
  private readonly byResolution: ReadonlyMap<string, string>;

  constructor(exchangeName: string, pairs: readonly (readonly [string, string])[]) {
    this.exchangeName = exchangeName;
    this.resolutions = pairs.map(([resolution]) => resolution);
    this.byResolution = new Map(pairs);
    this.native = this.resolutions.map((text) => {
      const resolution = parseResolution(text);
      if (!resolution) throw new Error(`Invalid ${exchangeName} resolution ${text}`);
      return resolution;
    });
  }

  of(resolution: Resolution): string | null {
    return this.byResolution.get(formatResolution(resolution)) ?? null;
  }

  /** The exchange's name for a native interval; anything else is an unsupported interval. */
  require(resolution: Resolution): string {
    const interval = this.of(resolution);
    if (interval === null) {
      throw new MarketError(
        'unsupported_resolution',
        `${this.exchangeName} doesn't serve this interval`,
      );
    }
    return interval;
  }
}

/** What every adapter's constructor takes. */
export interface ExchangeOptions {
  restUrl?: string | undefined;
  streamUrl?: string | undefined;
  fetch?: typeof fetch;
  /** Asset names for descriptions, filled by the search catalog. */
  names?: AssetNames;
  /** Fine-tuning for the stream connection (tests use short timings). */
  stream?: Omit<StreamClientOptions, 'url' | 'onWarning'>;
  onWarning?: (message: string) => void;
}
