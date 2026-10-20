import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogoStatus } from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from '../storage/jsonFile.ts';
import { maskKey, type SecretStore } from '../storage/secrets.ts';
import {
  COINS_PER_PAGE,
  type CoinGeckoClient,
  CoinGeckoError,
  type CoinGeckoKey,
  TICKERS_PER_PAGE,
} from './coingecko.ts';

/** Exchanges whose CoinGecko ticker lists map base assets to coins (the live ones). */
export const COINGECKO_EXCHANGES: Readonly<Record<string, string>> = { BINANCE: 'binance' };
/** Our exchange codes → CoinGecko's exchange ids, for exchange logos (OKX is "okex"). */
export const COINGECKO_EXCHANGE_IDS: Readonly<Record<string, string>> = {
  BINANCE: 'binance',
  BYBIT: 'bybit_spot',
  OKX: 'okex',
  COINBASE: 'gdax',
  KRAKEN: 'kraken',
};
/** Bumped when a refresh learns something new; an older list is refreshed at start. */
const INDEX_VERSION = 2;

/** Logos are refreshed weekly. */
export const LOGO_REFRESH_MS = 7 * 24 * 3_600_000;
const MAX_TICKER_PAGES = 60;
/** Top coins by market cap, for bases no exchange list maps: 2 pages of 250. */
const FALLBACK_PAGES = 2;
const MAX_IMAGE_BYTES = 256 * 1024;
/** Images come only from CoinGecko's own image hosts. */
const IMAGE_HOSTS = new Set(['coin-images.coingecko.com', 'assets.coingecko.com']);
/** Coin ids end up in file names, so they're held to this. */
const COIN_ID = /^[a-z0-9-]{1,64}$/;
const ASSET = /^[A-Z0-9]{1,20}$/;
const EXCHANGE = /^[A-Z]{1,16}$/;

interface LogoIndex {
  /** 1: coins only; 2: exchange logos too. */
  version: number;
  syncedAt: number;
  /** Per exchange code: base asset → coin id. */
  exchanges: Record<string, Record<string, string>>;
  /** Base asset → coin id by market cap, for bases the exchange lists didn't map. */
  fallback: Record<string, string>;
  /** Coin id → its 50 px image URL. */
  images: Record<string, string>;
  /** Our exchange code → its logo's URL. */
  exchangeImages: Record<string, string>;
}

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((item) => typeof item === 'string');

function parseIndex(value: unknown): LogoIndex | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, syncedAt, exchanges, fallback, images, exchangeImages } = value as Record<
    string,
    unknown
  >;
  if (typeof syncedAt !== 'number' || !isStringMap(fallback) || !isStringMap(images)) return null;
  if (typeof exchanges !== 'object' || exchanges === null) return null;
  if (!Object.values(exchanges).every(isStringMap)) return null;
  return {
    version: typeof version === 'number' ? version : 1,
    syncedAt,
    exchanges: exchanges as LogoIndex['exchanges'],
    fallback,
    images,
    exchangeImages: isStringMap(exchangeImages) ? exchangeImages : {},
  };
}

interface Settings {
  logosPromptDismissed: boolean;
}

function parseSettings(value: unknown): Settings | null {
  if (typeof value !== 'object' || value === null) return null;
  const { logosPromptDismissed } = value as Record<string, unknown>;
  return typeof logosPromptDismissed === 'boolean' ? { logosPromptDismissed } : null;
}

export interface LogoImage {
  bytes: Buffer;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface LogoServiceOptions {
  client: CoinGeckoClient;
  secrets: SecretStore;
  dataDir: string;
  /** For downloading images. */
  fetch?: typeof fetch;
  /** Gap between CoinGecko calls during a refresh, well inside the free plan's limit. */
  paceMs?: number;
  now?: () => number;
}

/**
 * Coin logos from CoinGecko: the key (kept by SecretStore), a weekly-refreshed map from each
 * exchange's base assets to CoinGecko coins, and 50 px images cached in `data/logos/` so they
 * keep working offline. The images themselves come from CoinGecko's CDN and cost no API calls.
 */
export class LogoService {
  private readonly client: CoinGeckoClient;
  private readonly secrets: SecretStore;
  private readonly fetchFn: typeof fetch;
  private readonly paceMs: number;
  private readonly now: () => number;
  private readonly indexFile: JsonFile<LogoIndex>;
  private readonly settingsFile: JsonFile<Settings>;
  private readonly imageDir: string;
  private readonly exchangeImageDir: string;
  private index: LogoIndex | null | undefined;
  private syncRun: Promise<void> | null = null;
  private syncError: string | null = null;
  private lastCall = Number.NEGATIVE_INFINITY;
  private readonly downloads = new Map<string, Promise<LogoImage | null>>();

  constructor(options: LogoServiceOptions) {
    this.client = options.client;
    this.secrets = options.secrets;
    this.fetchFn = options.fetch ?? fetch;
    this.paceMs = options.paceMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.indexFile = new JsonFile(join(options.dataDir, 'logos', 'index.json'), parseIndex);
    this.settingsFile = new JsonFile(join(options.dataDir, 'settings.json'), parseSettings);
    this.imageDir = join(options.dataDir, 'logos', 'coins');
    this.exchangeImageDir = join(options.dataDir, 'logos', 'exchanges');
  }

  async status(): Promise<LogoStatus> {
    const stored = await this.secrets.coingecko();
    const index = await this.loadIndex();
    const settings = await this.settingsFile.read();
    return {
      key: stored
        ? { masked: maskKey(stored.key), plan: stored.plan, source: stored.source }
        : null,
      promptDismissed: settings?.logosPromptDismissed ?? false,
      syncedAt: index?.syncedAt ?? null,
      syncing: this.syncRun !== null,
      syncError: this.syncError,
    };
  }

  /** Checks a key with CoinGecko, keeps it, and refreshes the logos in the background. */
  async saveKey(raw: string): Promise<LogoStatus> {
    const key = raw.trim();
    if (!/^[\x21-\x7e]{8,128}$/.test(key)) {
      throw new MarketError('bad_request', "That doesn't look like a CoinGecko API key");
    }
    if ((await this.secrets.coingecko())?.source === 'env') {
      throw new MarketError('bad_request', 'The key comes from COINGECKO_API_KEY; change it there');
    }
    let plan: CoinGeckoKey['plan'];
    try {
      plan = await this.client.check(key);
    } catch (error) {
      throw keyError(error);
    }
    await this.secrets.saveCoingecko(key, plan);
    this.syncError = null;
    this.startSync(true);
    return this.status();
  }

  async removeKey(): Promise<LogoStatus> {
    await this.secrets.removeCoingecko();
    return this.status();
  }

  async dismissPrompt(): Promise<LogoStatus> {
    await this.settingsFile.write({ logosPromptDismissed: true });
    return this.status();
  }

  /** Refreshes the logo list if there's a key and the list is missing, older or a week old. */
  async refreshIfStale(): Promise<void> {
    if (!(await this.secrets.coingecko())) return;
    const index = await this.loadIndex();
    if (!index || index.version < INDEX_VERSION || this.now() - index.syncedAt > LOGO_REFRESH_MS) {
      this.startSync(false);
    }
  }

  /** Resolves once any running refresh has finished. */
  async whenIdle(): Promise<void> {
    await this.syncRun;
  }

  /**
   * The logo of an exchange's base asset, from the cache or CoinGecko's CDN; null if none. An
   * exchange without its own ticker map uses another's for the same code (XRP is XRP on every
   * exchange), then the biggest coin by market cap with that symbol.
   */
  async logo(exchange: string, base: string): Promise<LogoImage | null> {
    if (!EXCHANGE.test(exchange) || !ASSET.test(base)) return null;
    const index = await this.loadIndex();
    if (!index) return null;
    const coinId =
      index.exchanges[exchange]?.[base] ??
      Object.values(index.exchanges).find((bases) => bases[base])?.[base] ??
      index.fallback[base];
    if (!coinId || !COIN_ID.test(coinId)) return null;
    return this.image(this.imageDir, coinId, index.images[coinId]);
  }

  /** An exchange's logo, from the cache or CoinGecko's CDN; null if none. */
  async exchangeLogo(exchange: string): Promise<LogoImage | null> {
    if (!EXCHANGE.test(exchange)) return null;
    const index = await this.loadIndex();
    const url = index?.exchangeImages[exchange];
    return url ? this.image(this.exchangeImageDir, exchange.toLowerCase(), url) : null;
  }

  private async image(
    dir: string,
    name: string,
    url: string | undefined,
  ): Promise<LogoImage | null> {
    const cached = await this.readCached(dir, name);
    if (cached) return cached;
    if (!url) return null;
    const key = `${dir}/${name}`;
    let download = this.downloads.get(key);
    if (!download) {
      download = this.download(dir, name, url).finally(() => this.downloads.delete(key));
      this.downloads.set(key, download);
    }
    return download;
  }

  private startSync(force: boolean): void {
    if (this.syncRun && !force) return;
    const previous = this.syncRun ?? Promise.resolve();
    const run: Promise<void> = previous
      .then(() => this.sync())
      .finally(() => {
        if (this.syncRun === run) this.syncRun = null;
      });
    this.syncRun = run;
  }

  private async sync(): Promise<void> {
    const stored = await this.secrets.coingecko();
    if (!stored) return;
    try {
      let plan = stored.plan;
      if (!plan) {
        plan = await this.call(() => this.client.check(stored.key));
        if (stored.source === 'env') this.secrets.setEnvPlan(plan);
      }
      const key: CoinGeckoKey = { key: stored.key, plan };
      const exchanges: LogoIndex['exchanges'] = {};
      for (const [code, id] of Object.entries(COINGECKO_EXCHANGES)) {
        const bases: Record<string, string> = {};
        for (let page = 1; page <= MAX_TICKER_PAGES; page++) {
          const tickers = await this.call(() => this.client.exchangeTickers(key, id, page));
          // Most traded first, so the main listing of a base asset decides its coin.
          for (const { base, coinId } of tickers) {
            if (coinId && COIN_ID.test(coinId) && ASSET.test(base) && !(base in bases)) {
              bases[base] = coinId;
            }
          }
          if (tickers.length < TICKERS_PER_PAGE) break;
        }
        exchanges[code] = bases;
      }
      const images: Record<string, string> = {};
      const fallback: Record<string, string> = {};
      for (let page = 1; page <= FALLBACK_PAGES; page++) {
        const coins = await this.call(() => this.client.coins(key, null, page));
        for (const coin of coins) {
          if (!COIN_ID.test(coin.id)) continue;
          if (coin.image) images[coin.id] = coin.image;
          const base = coin.symbol.toUpperCase();
          if (ASSET.test(base) && !(base in fallback)) fallback[base] = coin.id; // biggest first
        }
      }
      const mapped = new Set(Object.values(exchanges).flatMap((bases) => Object.values(bases)));
      const missing = [...mapped].filter((id) => !(id in images));
      for (let i = 0; i < missing.length; i += COINS_PER_PAGE) {
        const chunk = missing.slice(i, i + COINS_PER_PAGE);
        for (const coin of await this.call(() => this.client.coins(key, chunk))) {
          if (coin.image && COIN_ID.test(coin.id)) images[coin.id] = coin.image;
        }
      }
      const exchangeImages: Record<string, string> = {};
      const logos = await this.call(() => this.client.exchanges(key));
      for (const [code, id] of Object.entries(COINGECKO_EXCHANGE_IDS)) {
        const image = logos.find((exchange) => exchange.id === id)?.image;
        if (image) exchangeImages[code] = image;
      }
      this.index = {
        version: INDEX_VERSION,
        syncedAt: this.now(),
        exchanges,
        fallback,
        images,
        exchangeImages,
      };
      await this.indexFile.write(this.index);
      this.syncError = null;
    } catch (error) {
      this.syncError =
        error instanceof CoinGeckoError ? error.message : 'The logo list could not be refreshed';
    }
  }

  /** One CoinGecko call, spaced out from the previous one. */
  private async call<T>(request: () => Promise<T>): Promise<T> {
    const wait = this.lastCall + this.paceMs - this.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCall = this.now();
    return request();
  }

  private async loadIndex(): Promise<LogoIndex | null> {
    if (this.index === undefined) {
      const stored = await this.indexFile.read();
      // A refresh may have finished while the file was being read; its list is newer.
      if (this.index === undefined) this.index = stored;
    }
    return this.index ?? null;
  }

  private async readCached(dir: string, name: string): Promise<LogoImage | null> {
    try {
      const bytes = await readFile(join(dir, name));
      const contentType = imageType(bytes);
      return contentType ? { bytes, contentType } : null;
    } catch {
      return null;
    }
  }

  private async download(dir: string, name: string, url: string): Promise<LogoImage | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.has(parsed.hostname)) return null;
    try {
      const response = await this.fetchFn(parsed, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = bytes.length <= MAX_IMAGE_BYTES ? imageType(bytes) : null;
      if (!contentType) return null;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = join(dir, `${name}.${process.pid}.tmp`);
      await writeFile(temp, bytes);
      await rename(temp, join(dir, name));
      return { bytes, contentType };
    } catch {
      return null; // offline or refused: the row keeps its letter avatar
    }
  }
}

/** PNG, JPEG or WebP by their first bytes; anything else (SVG included) is refused. */
function imageType(bytes: Buffer): LogoImage['contentType'] | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function keyError(error: unknown): MarketError {
  if (error instanceof CoinGeckoError) {
    switch (error.problem) {
      case 'rejected':
        return new MarketError('bad_request', 'CoinGecko rejected this key');
      case 'rate_limited':
        return new MarketError(
          'rate_limited',
          'CoinGecko is rate-limiting requests; try again in a minute',
        );
      case 'unreachable':
        return new MarketError('upstream_error', 'CoinGecko is unreachable; check your connection');
    }
  }
  return new MarketError('internal_error', 'The key could not be checked');
}
