import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoinGeckoClient } from '../src/logos/coingecko.ts';
import { LOGO_REFRESH_MS, LogoService } from '../src/logos/LogoService.ts';
import { MarketError } from '../src/market/types.ts';
import { maskKey, SecretStore } from '../src/storage/secrets.ts';
import { fakeCoinGecko, PNG_BYTES } from './helpers/FakeCoinGecko.ts';

const KEY = 'CG-demo-key-3f9a';

function setup(fakeOptions: Parameters<typeof fakeCoinGecko>[0] = {}, env: NodeJS.ProcessEnv = {}) {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'tradingnerd-logos-')), 'data');
  const fake = fakeCoinGecko({
    tickers: [
      ['BTC', 'bitcoin'],
      ['LINK', 'chainlink'],
      ['ARB', 'arbitrum'],
      ['WEIRD', null],
    ],
    coins: [
      ['bitcoin', 'btc'],
      ['ripple', 'xrp'],
      ['chainlink', 'link'],
      ['arbitrum', 'arb'],
      ['weird-coin', 'weird'],
    ],
    ...fakeOptions,
  });
  let now = Date.UTC(2026, 9, 19);
  const secrets = new SecretStore(dataDir, env);
  const logos = new LogoService({
    client: new CoinGeckoClient({ fetch: fake.fetch }),
    secrets,
    dataDir,
    fetch: fake.fetch,
    paceMs: 0,
    now: () => now,
  });
  return {
    logos,
    secrets,
    fake,
    dataDir,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function errorOf(promise: Promise<unknown>): Promise<MarketError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('CoinGecko keys', () => {
  it('checks a key with /ping, sending it only in its header', async () => {
    const { logos, fake } = setup();
    const status = await logos.saveKey(`  ${KEY}  `);
    expect(status.key).toEqual({ masked: '••••3f9a', plan: 'demo', source: 'file' });
    const ping = fake.calls[0];
    expect(ping?.url).toBe('https://api.coingecko.com/api/v3/ping');
    expect(ping?.headers['x-cg-demo-api-key']).toBe(KEY);
    expect(fake.calls.every((call) => !call.url.includes(KEY))).toBe(true);
  });

  it('recognises a Pro key', async () => {
    const { logos } = setup({ keys: { 'CG-pro-key-9999': 'pro' } });
    expect((await logos.saveKey('CG-pro-key-9999')).key?.plan).toBe('pro');
  });

  it.each([
    [
      'a key CoinGecko rejects',
      {},
      'CG-wrong-key-0000',
      'bad_request',
      'CoinGecko rejected this key',
    ],
    ['a rate-limited check', { status: 429 }, KEY, 'rate_limited', 'rate-limiting'],
    ['no connection', { offline: true }, KEY, 'upstream_error', 'unreachable'],
    ['something that is not a key', {}, 'short', 'bad_request', "doesn't look like"],
  ])('explains %s, and keeps nothing', async (_label, options, key, code, message) => {
    const { logos, dataDir } = setup(options);
    const error = await errorOf(logos.saveKey(key));
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
    expect((await logos.status()).key).toBeNull();
    expect(() => readdirSync(dataDir)).toThrow(); // nothing written at all
  });

  it('keeps the key readable by the owner only, and removes it', async () => {
    const { logos, dataDir } = setup();
    await logos.saveKey(KEY);
    const file = join(dataDir, 'secrets.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      coingecko: { key: KEY, plan: 'demo' },
    });
    expect((await logos.removeKey()).key).toBeNull();
  });

  it('lets COINGECKO_API_KEY override the file, and refuses to replace it', async () => {
    const { logos } = setup({}, { COINGECKO_API_KEY: KEY });
    expect((await logos.status()).key).toEqual({ masked: '••••3f9a', plan: null, source: 'env' });
    expect((await errorOf(logos.saveKey('CG-other-key-1111'))).message).toContain(
      'COINGECKO_API_KEY',
    );
    await logos.refreshIfStale();
    await logos.whenIdle();
    expect((await logos.status()).key?.plan).toBe('demo');
  });

  it('never puts more than the last four characters in a status', async () => {
    const { logos } = setup();
    await logos.saveKey(KEY);
    await logos.whenIdle();
    expect(JSON.stringify(await logos.status())).not.toContain(KEY.slice(0, -4));
    expect(maskKey('abc')).toBe('••••');
  });
});

describe('the logo list', () => {
  it("maps each exchange's base assets to coins, falling back to market cap", async () => {
    const { logos } = setup();
    await logos.saveKey(KEY);
    await logos.whenIdle();
    expect((await logos.status()).syncedAt).toBe(Date.UTC(2026, 9, 19));
    expect((await logos.logo('BINANCE', 'LINK'))?.contentType).toBe('image/png');
    // XRP isn't in the exchange list here; the market-cap list knows it.
    expect((await logos.logo('BINANCE', 'XRP'))?.bytes.equals(PNG_BYTES)).toBe(true);
    expect(await logos.logo('BINANCE', 'NOPE')).toBeNull();
  });

  it('caches images, which then work offline', async () => {
    const { logos, fake } = setup();
    await logos.saveKey(KEY);
    await logos.whenIdle();
    await logos.logo('BINANCE', 'LINK');
    const downloads = fake.calls.filter((call) => call.url.includes('coin-images')).length;
    await logos.logo('BINANCE', 'LINK');
    expect(fake.calls.filter((call) => call.url.includes('coin-images')).length).toBe(downloads);
    expect(fake.calls.find((call) => call.url.includes('coin-images'))?.url).toContain('/small/');
  });

  it('refuses images that are not PNG, JPEG or WebP', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const { logos } = setup({ imageBytes: { chainlink: svg } });
    await logos.saveKey(KEY);
    await logos.whenIdle();
    expect(await logos.logo('BINANCE', 'LINK')).toBeNull();
  });

  it('ignores lookups that could reach outside the cache', async () => {
    const { logos } = setup();
    await logos.saveKey(KEY);
    await logos.whenIdle();
    expect(await logos.logo('BINANCE', '../SECRETS')).toBeNull();
    expect(await logos.logo('../..', 'LINK')).toBeNull();
  });

  it('refreshes weekly, and only with a key', async () => {
    const { logos, fake, advance } = setup();
    await logos.refreshIfStale();
    expect(fake.calls).toEqual([]);
    await logos.saveKey(KEY);
    await logos.whenIdle();
    const calls = fake.calls.length;
    await logos.refreshIfStale();
    await logos.whenIdle();
    expect(fake.calls.length).toBe(calls);
    advance(LOGO_REFRESH_MS + 1);
    await logos.refreshIfStale();
    await logos.whenIdle();
    expect(fake.calls.length).toBeGreaterThan(calls);
  });

  it("serves each exchange's logo, cached like coin logos", async () => {
    const { logos, fake, dataDir } = setup();
    expect(await logos.exchangeLogo('BINANCE')).toBeNull(); // no list yet
    await logos.saveKey(KEY);
    await logos.whenIdle();
    expect((await logos.exchangeLogo('BYBIT'))?.bytes.equals(PNG_BYTES)).toBe(true);
    // CoinGecko calls Bybit's spot exchange "bybit_spot", OKX "okex", Coinbase "gdax".
    expect(
      fake.calls.some((call) => call.url.endsWith('/markets/images/9/small/bybit_spot.png')),
    ).toBe(true);
    expect(readdirSync(join(dataDir, 'logos', 'exchanges'))).toEqual(['bybit']);
    const downloads = fake.calls.length;
    await logos.exchangeLogo('BYBIT');
    expect(fake.calls.length).toBe(downloads);
    expect(await logos.exchangeLogo('NOPE')).toBeNull();
    expect(await logos.exchangeLogo('../..')).toBeNull();
  });

  it('finds a coin on another exchange through the mapped exchange, then market cap', async () => {
    const { logos } = setup();
    await logos.saveKey(KEY);
    await logos.whenIdle();
    expect((await logos.logo('KRAKEN', 'LINK'))?.contentType).toBe('image/png');
    expect((await logos.logo('KRAKEN', 'XRP'))?.contentType).toBe('image/png');
    expect(await logos.logo('KRAKEN', 'NOPE')).toBeNull();
  });

  it('refreshes a list saved before exchange logos existed, even when recent', async () => {
    const { logos, fake, dataDir } = setup();
    await logos.saveKey(KEY);
    await logos.whenIdle();
    const file = join(dataDir, 'logos', 'index.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    expect(index.version).toBe(3);
    delete index.version;
    delete index.exchangeImages;
    writeFileSync(file, JSON.stringify(index));

    // A new gateway reads the old list: still searchable, but due for a refresh.
    const restarted = new LogoService({
      client: new CoinGeckoClient({ fetch: fake.fetch }),
      secrets: new SecretStore(dataDir, {}),
      dataDir,
      fetch: fake.fetch,
      paceMs: 0,
      now: () => Date.UTC(2026, 9, 19),
    });
    expect((await restarted.logo('BINANCE', 'LINK'))?.contentType).toBe('image/png');
    const calls = fake.calls.length;
    await restarted.refreshIfStale();
    await restarted.whenIdle();
    expect(fake.calls.length).toBeGreaterThan(calls);
    expect((await restarted.exchangeLogo('KRAKEN'))?.contentType).toBe('image/png');
  });

  it("refreshes a list saved before Bitstamp's logo, which it then has", async () => {
    const { logos, fake, dataDir } = setup();
    await logos.saveKey(KEY);
    await logos.whenIdle();
    const file = join(dataDir, 'logos', 'index.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    expect(index.exchangeImages.BITSTAMP).toBeDefined();
    // As the list was until Bitstamp came: version 2, no logo for it.
    index.version = 2;
    delete index.exchangeImages.BITSTAMP;
    writeFileSync(file, JSON.stringify(index));

    const restarted = new LogoService({
      client: new CoinGeckoClient({ fetch: fake.fetch }),
      secrets: new SecretStore(dataDir, {}),
      dataDir,
      fetch: fake.fetch,
      paceMs: 0,
      now: () => Date.UTC(2026, 9, 19),
    });
    expect(await restarted.exchangeLogo('BITSTAMP')).toBeNull();
    await restarted.refreshIfStale();
    await restarted.whenIdle();
    expect((await restarted.exchangeLogo('BITSTAMP'))?.contentType).toBe('image/png');
  });

  it('remembers that the first-launch prompt was skipped', async () => {
    const { logos } = setup();
    expect((await logos.status()).promptDismissed).toBe(false);
    expect((await logos.dismissPrompt()).promptDismissed).toBe(true);
  });
});
