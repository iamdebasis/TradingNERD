import {
  type BarClock,
  DELAYED_SIP_MS,
  type MarketSchedule,
  type Resolution,
  type SessionHours,
  type SipAccess,
  type StockKeyStatus,
  sessionClock,
} from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { maskKey, type SecretStore } from '../storage/secrets.ts';
import { AlpacaStream } from './AlpacaStream.ts';
import { AlpacaClient, type AlpacaKey } from './alpaca.ts';
import { US_EXCHANGES } from './listings.ts';
import { MarketCalendar } from './MarketCalendar.ts';
import { MinutePoller } from './MinutePoller.ts';
import type { UsListings } from './UsListings.ts';
import { UsStockExchange } from './UsStockExchange.ts';

const DAY: Resolution = { count: 1, unit: 'day' };
/** Symbols per ranking request, and the pause between them, so charts keep their share. */
const RANK_BATCH = 200;
const RANK_PAUSE_MS = 1_500;
/** The ranking and the asset list are checked this often, and refreshed after each session. */
const UNIVERSE_CHECK_MS = 3 * 3_600_000;

export interface UsStocksMarketOptions {
  dataDir: string;
  secrets: SecretStore;
  listings: UsListings;
  fetch?: typeof fetch;
  dataUrl?: string | undefined;
  tradingUrls?: readonly string[] | undefined;
  /** Alpaca's market data stream (its host; tests point it elsewhere). */
  streamUrl?: string | undefined;
  /** Symbols streamed at once (the free plan's 30 when absent). */
  streamSymbols?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWarning?: (message: string) => void;
}

/**
 * US stocks and ETFs from Alpaca (docs/SPEC.md §5.7): what the exchange adapters (NASDAQ,
 * NYSE, AMEX, CBOE, …) share. The user's key and how its plan serves the whole market, the
 * trading calendar, the live minute poller, the trade and quote stream, and the listings'
 * ranking and data availability.
 */
export class UsStocksMarket {
  readonly client: AlpacaClient;
  readonly calendar: MarketCalendar;
  readonly poller: MinutePoller;
  /** Trades between the minute bars, and the best bid and ask (the legend's Sell and Buy). */
  readonly stream: AlpacaStream;
  readonly listings: UsListings;
  /** Regular-hours bars on the current calendar: one object, so feeds can keep it. */
  readonly clock: BarClock;
  /** Intraday bars from the pre-market open to the post-market close, likewise. */
  readonly extendedClock: BarClock;
  private readonly secrets: SecretStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warn: (message: string) => void;
  private sip: SipAccess | null = null;
  private readonly adapters: UsStockExchange[];
  private clocks = new WeakMap<MarketSchedule, Record<SessionHours, BarClock>>();
  private prepared: Promise<void> | null = null;
  private universe: Promise<void> | null = null;
  /** The session close the ranking was last taken after. */
  private rankedFor: number | null = null;
  private universeTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: UsStocksMarketOptions) {
    this.secrets = options.secrets;
    this.listings = options.listings;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.warn = options.onWarning ?? (() => {});
    this.client = new AlpacaClient({
      key: () => this.key(),
      sip: () => this.sip,
      dataUrl: options.dataUrl,
      tradingUrls: options.tradingUrls,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      now: this.now,
      sleep: this.sleep,
    });
    this.calendar = new MarketCalendar({
      dataDir: options.dataDir,
      fetchDays: (from, to) => this.client.calendar(from, to),
      now: this.now,
      onWarning: this.warn,
    });
    this.clock = this.followingCalendar('regular');
    this.extendedClock = this.followingCalendar('extended');
    this.poller = new MinutePoller({
      client: this.client,
      clock: (hours) => this.currentClock(hours),
      schedule: () => this.calendar.schedule(),
      now: this.now,
      onWarning: this.warn,
    });
    this.stream = new AlpacaStream({
      url: options.streamUrl,
      key: () => this.key(),
      sip: () => this.sip,
      ...(options.streamSymbols ? { maxSymbols: options.streamSymbols } : {}),
      onWarning: this.warn,
    });
    this.adapters = US_EXCHANGES.map((exchange) => new UsStockExchange(this, exchange));
  }

  /** One adapter per US exchange code. */
  exchanges(): readonly UsStockExchange[] {
    return this.adapters;
  }

  /** The bars of a session's hours (day and longer bars are the regular sessions either way). */
  clockFor(hours: SessionHours): BarClock {
    return hours === 'extended' ? this.extendedClock : this.clock;
  }

  /** How far behind real time the data runs: 15 minutes on the free plan. */
  delayMs(): number {
    return this.sip === 'realtime' ? 0 : DELAYED_SIP_MS;
  }

  /** Loads the key's plan and the calendar; refreshes the ranking in the background. */
  prepare(): Promise<void> {
    this.prepared ??= this.load();
    return this.prepared;
  }

  /** Lookups wait for the listings and, with a key, the calendar. */
  async ready(): Promise<void> {
    await this.prepare();
    await this.listings.start();
  }

  /** Throws `needs_key` without a key; loads the calendar if it isn't in yet. */
  async requireData(): Promise<void> {
    await this.ready();
    if (!(await this.key())) {
      throw new MarketError('needs_key', 'US stock data needs your Alpaca key');
    }
    if (!this.calendar.isKnown()) await this.calendar.ensure();
  }

  async status(): Promise<StockKeyStatus> {
    const stored = await this.secrets.alpaca();
    return {
      configured: stored !== null,
      source: stored?.source ?? null,
      keyId: stored ? maskKey(stored.keyId) : null,
      sip: stored?.sip ?? null,
    };
  }

  /** Checks a key with Alpaca, then keeps it: data, the calendar and the ranking follow. */
  async saveKey(keyId: string, secret: string): Promise<StockKeyStatus> {
    const key = { keyId: keyId.trim(), secret: secret.trim() };
    if (!/^[A-Za-z0-9]{8,64}$/.test(key.keyId) || !/^[A-Za-z0-9/+=_-]{8,128}$/.test(key.secret)) {
      throw new MarketError('bad_request', "That doesn't look like an Alpaca key ID and secret");
    }
    if ((await this.secrets.alpaca())?.source === 'env') {
      throw new MarketError(
        'bad_request',
        'The Alpaca key is set by APCA_API_KEY_ID and APCA_API_SECRET_KEY; change it there',
      );
    }
    const sip = await this.client.checkKey(key);
    await this.secrets.saveAlpaca(key.keyId, key.secret, sip);
    this.sip = sip;
    await this.calendar.ensure().catch((error: unknown) => {
      this.warn(`Couldn't load the US calendar (${String(error)})`);
    });
    this.refreshUniverse();
    this.stream.restart();
    void this.poller.pollNow();
    return this.status();
  }

  async removeKey(): Promise<StockKeyStatus> {
    if ((await this.secrets.alpaca())?.source === 'env') {
      throw new MarketError(
        'bad_request',
        'The Alpaca key is set in the environment; remove it there',
      );
    }
    await this.secrets.removeAlpaca();
    this.sip = null;
    this.stream.restart();
    return this.status();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.universeTimer);
    this.poller.close();
    this.stream.close();
    this.listings.close();
  }

  private async load(): Promise<void> {
    const stored = await this.secrets.alpaca();
    if (!stored) return;
    this.sip = stored.sip;
    if (stored.sip === null) {
      try {
        this.sip = await this.client.checkKey(stored);
        this.secrets.setEnvSip(this.sip);
      } catch (error) {
        this.warn(`Couldn't check the Alpaca key (${String(error)})`);
      }
    }
    await this.calendar.ensure().catch((error: unknown) => {
      this.warn(`Couldn't load the US calendar (${String(error)})`);
    });
    this.refreshUniverse();
    this.universeTimer = setInterval(() => this.refreshUniverse(), UNIVERSE_CHECK_MS);
    this.universeTimer.unref?.();
  }

  private async key(): Promise<AlpacaKey | null> {
    const stored = await this.secrets.alpaca();
    return stored ? { keyId: stored.keyId, secret: stored.secret } : null;
  }

  private currentClock(hours: SessionHours): BarClock {
    const schedule = this.calendar.schedule();
    let clocks = this.clocks.get(schedule);
    if (!clocks) {
      clocks = { regular: sessionClock(schedule), extended: sessionClock(schedule, 'extended') };
      this.clocks.set(schedule, clocks);
    }
    return clocks[hours];
  }

  /** A clock that always follows the current calendar (it may arrive after a feed starts). */
  private followingCalendar(hours: SessionHours): BarClock {
    const current = () => this.currentClock(hours);
    return {
      continuous: false,
      open: (resolution, ms) => current().open(resolution, ms),
      close: (resolution, openMs) => current().close(resolution, openMs),
      next: (resolution, openMs) => current().next(resolution, openMs),
      nestsIn: (base, target) => current().nestsIn(base, target),
      isOpen: (ms) => current().isOpen(ms),
    };
  }

  /** Alpaca's symbol list and the last session's traded values, once per session. */
  private refreshUniverse(): void {
    if (this.universe || this.closed) return;
    this.universe = this.updateUniverse()
      .catch((error: unknown) => this.warn(`Couldn't rank the US listings (${String(error)})`))
      .finally(() => {
        this.universe = null;
      });
  }

  private async updateUniverse(): Promise<void> {
    if (!(await this.key())) return;
    await this.listings.start();
    const clock = this.currentClock('regular');
    const available = this.client.latestAvailable();
    let session = clock.open(DAY, available);
    let close = clock.close(DAY, session);
    if (available < close) {
      // Today's session is still going: rank by the one before.
      session = clock.open(DAY, session - 1);
      close = clock.close(DAY, session);
    }
    if (this.rankedFor === close) return;
    const assets = await this.client.assets();
    await this.listings.setAvailable(assets.map((asset) => asset.symbol));
    const symbols = new Map<string, string>();
    for (const listing of this.listings.all()) {
      if (listing.dataSymbol && this.listings.hasData(listing))
        symbols.set(listing.dataSymbol, listing.ticker);
    }
    const date = new Date(session).toISOString().slice(0, 10);
    const volumes: Record<string, number> = {};
    const prices: Record<string, number> = {};
    const all = [...symbols.keys()];
    for (let i = 0; i < all.length && !this.closed; i += RANK_BATCH) {
      const batch = all.slice(i, i + RANK_BATCH);
      const bars = await this.client.bars(batch, {
        timeframe: '1Day',
        start: session - 86_400_000,
        end: close,
        limit: batch.length * 2 + 4,
        sort: 'asc',
      });
      for (const [symbol, list] of bars) {
        const bar = list.find(
          (item) => new Date(item.time * 1000).toISOString().slice(0, 10) === date,
        );
        const ticker = symbols.get(symbol);
        if (!bar || !ticker) continue;
        volumes[ticker] = Math.round(bar.volume * bar.close);
        prices[ticker] = bar.close;
      }
      await this.sleep(RANK_PAUSE_MS);
    }
    await this.listings.setVolumes(volumes, prices);
    this.rankedFor = close;
  }
}
