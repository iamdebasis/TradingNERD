import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEntries, mergeNames, usdRates } from '../src/catalog/entries.ts';
import {
  CATALOG_REFRESH_MS,
  CATALOG_RETRY_MS,
  SymbolCatalog,
} from '../src/catalog/SymbolCatalog.ts';
import { FakeCatalogSource, pair } from './helpers/FakeCatalog.ts';

const binance = () =>
  new FakeCatalogSource(
    'BINANCE',
    'Binance',
    [
      pair('XRPUSDT', 'XRP', 'USDT', 96_533_149, 1.314),
      pair('BTCUSDT', 'BTC', 'USDT', 954_692_944, 82_810.21),
      pair('XRPBTC', 'XRP', 'BTC', 10.84216386, 0.00001587),
      pair('USDTTRY', 'USDT', 'TRY', 851_059_870, 49.44),
      pair('XRPTRY', 'XRP', 'TRY', 157_802_274, 64.97),
    ],
    { USDT: 'TetherUS', BTC: 'Bitcoin', XRP: 'XRP', TRY: 'Turkish Lira', USD: 'USD' },
  );
const kraken = () =>
  new FakeCatalogSource('KRAKEN', 'Kraken', [
    pair('XBTUSD', 'XBT', 'USD', 117_000_000, 82_706.7),
    pair('XRPUSDT', 'XRP', 'USDT', 958_000, 1.31293),
  ]);
const coinbase = () =>
  new FakeCatalogSource(
    'COINBASE',
    'Coinbase',
    [pair('XRPUSD', 'XRP', 'USD', 66_692_210, 1.3125)],
    { USD: 'US Dollar', USDT: 'Tether', XRP: 'XRP' },
  );

const tempDir = () => join(mkdtempSync(join(tmpdir(), 'tradingnerd-catalog-')), 'data');

describe('catalog entries', () => {
  it("turns volumes into dollars with each exchange's own prices", () => {
    const rates = usdRates(binance().snapshot.pairs);
    expect(rates.get('USDT')).toBe(1);
    expect(rates.get('BTC')).toBe(82_810.21); // from BTCUSDT
    expect(rates.get('TRY')).toBeCloseTo(1 / 49.44, 10); // from USDTTRY, inverted
    expect(rates.has('XRP')).toBe(true);
  });

  it('names assets as Binance does, filling bare codes from others; Kraken codes normalized', () => {
    const names = mergeNames([binance().snapshot.names, coinbase().snapshot.names]);
    expect(names.get('USDT')).toBe('TetherUS'); // Binance's, not Coinbase's "Tether"
    expect(names.get('USD')).toBe('US Dollar'); // Binance only repeats the code
    expect(mergeNames([{ XBT: 'Bitcoin' }]).get('BTC')).toBe('Bitcoin');

    const entries = buildEntries(
      [binance(), kraken(), coinbase()].map((source) => ({
        id: source.id,
        snapshot: source.snapshot,
      })),
      new Set(['BINANCE']),
    );
    expect(entries.find((entry) => entry.ticker === 'XBTUSD')).toEqual({
      exchange: 'KRAKEN',
      ticker: 'XBTUSD',
      base: 'BTC',
      quote: 'USD',
      description: 'Bitcoin / US Dollar',
      volumeUsd: 117_000_000,
      live: false,
    });
    const xrpBtc = entries.find((entry) => entry.ticker === 'XRPBTC');
    expect(xrpBtc?.description).toBe('XRP / Bitcoin');
    expect(xrpBtc?.volumeUsd).toBeCloseTo(10.84216386 * 82_810.21, 2);
    expect(xrpBtc?.live).toBe(true);
    const xrpTry = entries.find((entry) => entry.ticker === 'XRPTRY');
    expect(xrpTry?.description).toBe('XRP / Turkish Lira');
    expect(xrpTry?.volumeUsd).toBeCloseTo(157_802_274 / 49.44, 0);
  });

  it('lists a ticker once per exchange', () => {
    const doubled = new FakeCatalogSource('KRAKEN', 'Kraken', [
      pair('XRPUSD', 'XRP', 'USD', 5, 1),
      pair('XRPUSD', 'XRP', 'USD', 9, 1),
    ]);
    expect(buildEntries([{ id: 'KRAKEN', snapshot: doubled.snapshot }], new Set()).length).toBe(1);
  });
});

describe('SymbolCatalog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("searches every exchange's pairs, one match per ticker, live exchanges first", async () => {
    const sources = [binance(), kraken(), coinbase()];
    const catalog = new SymbolCatalog({ sources, live: new Set(['BINANCE']), dataDir: tempDir() });
    await catalog.ready(1_000);
    const { matches } = catalog.search({ query: 'XRPUSDT' });
    expect(matches[0]?.listings.map((listing) => listing.id)).toEqual([
      'BINANCE:XRPUSDT',
      'KRAKEN:XRPUSDT',
    ]);
    expect(matches[0]?.description).toBe('XRP / TetherUS');
    expect(catalog.exchanges()).toEqual([
      { id: 'BINANCE', name: 'Binance', live: true },
      { id: 'KRAKEN', name: 'Kraken', live: false },
      { id: 'COINBASE', name: 'Coinbase', live: false },
    ]);
    expect(sources.map((source) => source.calls)).toEqual([1, 1, 1]);
    catalog.close();
  });

  it('keeps the lists in data/catalog.json, so a restart searches at once, offline too', async () => {
    const dataDir = tempDir();
    const first = new SymbolCatalog({
      sources: [binance(), kraken()],
      live: new Set(['BINANCE']),
      dataDir,
    });
    await first.ready(1_000);
    await vi.waitFor(() => readFileSync(join(dataDir, 'catalog.json'), 'utf8'));
    first.close();
    const saved = readFileSync(join(dataDir, 'catalog.json'), 'utf8');
    expect(saved.split('\n').filter(Boolean)).toHaveLength(1); // one compact line

    const offline = [binance(), kraken()];
    for (const source of offline) source.failing = true;
    const second = new SymbolCatalog({ sources: offline, live: new Set(['BINANCE']), dataDir });
    await second.ready(1_000);
    expect(second.search({ query: 'XBT' }).matches.map((match) => match.ticker)).toEqual([
      'XBTUSD',
    ]);
    // Saved lists are less than 12 hours old, so nothing was fetched.
    expect(offline.map((source) => source.calls)).toEqual([0, 0]);
    second.close();
  });

  it('fetches each list again after 12 hours, and retries a failed fetch in 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const source = binance();
    const catalog = new SymbolCatalog({
      sources: [source],
      live: new Set(['BINANCE']),
      dataDir: tempDir(),
    });
    await catalog.start();
    await vi.waitFor(() => expect(source.calls).toBe(1));

    source.failing = true;
    await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_MS - 1_000);
    expect(source.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.calls).toBe(2); // failed: the old list stays searchable
    expect(catalog.search({ query: 'XRPUSDT' }).matches).toHaveLength(1);

    source.failing = false;
    source.snapshot.pairs.push(pair('LDOUSDT', 'LDO', 'USDT', 9e6, 0.4));
    await vi.advanceTimersByTimeAsync(CATALOG_RETRY_MS);
    expect(source.calls).toBe(3);
    expect(catalog.search({ query: 'LDO' }).matches.map((match) => match.ticker)).toEqual([
      'LDOUSDT',
    ]);

    catalog.close(); // and nothing more after closing
    await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_MS * 2);
    expect(source.calls).toBe(3);
  });

  it('answers a first search once any exchange has listed its pairs, without waiting for all', async () => {
    const slow = new FakeCatalogSource('KRAKEN', 'Kraken', []);
    slow.fetchCatalog = () => new Promise(() => {}); // never answers
    const catalog = new SymbolCatalog({
      sources: [binance(), slow],
      live: new Set(['BINANCE']),
      dataDir: tempDir(),
    });
    const started = Date.now();
    await catalog.ready(5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(catalog.search({ query: 'XRP' }).matches.length).toBeGreaterThan(0);
    catalog.close();
  });

  it('gives up waiting after the timeout when nothing can be listed', async () => {
    const down = binance();
    down.failing = true;
    const hang = new FakeCatalogSource('KRAKEN', 'Kraken', []);
    hang.fetchCatalog = () => new Promise(() => {});
    const catalog = new SymbolCatalog({
      sources: [down, hang],
      live: new Set(),
      dataDir: tempDir(),
      onWarning: () => {},
    });
    const started = Date.now();
    await catalog.ready(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(catalog.search({ query: 'XRP' })).toEqual({ matches: [], hasMore: false });
    catalog.close();
  });
});
