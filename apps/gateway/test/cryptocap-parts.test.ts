import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogEntry } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { AnchorBook } from '../src/cryptocap/anchors.ts';
import { decimalsFor } from '../src/cryptocap/CryptoCapExchange.ts';
import { type CoinCapBar, compositeBars, divideBars } from '../src/cryptocap/indices.ts';
import { PairBook } from '../src/cryptocap/pairs.ts';
import { capDescription, capTickerText, parseCapTicker } from '../src/cryptocap/symbols.ts';
import { CoinGeckoUsage, SLOW_AFTER, STOP_AFTER } from '../src/logos/usage.ts';

const tempDir = (name: string) => mkdtempSync(join(tmpdir(), `tradingnerd-${name}-`));

describe('CRYPTOCAP tickers', () => {
  it.each([
    ['TOTAL', { kind: 'composite', name: 'TOTAL' }],
    ['total2', { kind: 'composite', name: 'TOTAL2' }],
    ['STABLE.C', { kind: 'composite', name: 'STABLE.C' }],
    ['OTHERSBTC', { kind: 'ratio', name: 'OTHERSBTC' }],
    ['XRP', { kind: 'coin', symbol: 'XRP' }],
    ['1INCH', { kind: 'coin', symbol: '1INCH' }],
    ['BTC.D', { kind: 'dominance', of: { kind: 'coin', symbol: 'BTC' } }],
    ['OTHERS.D', { kind: 'dominance', of: { kind: 'composite', name: 'OTHERS' } }],
    ['STABLE.C.D', { kind: 'dominance', of: { kind: 'composite', name: 'STABLE.C' } }],
  ])('reads %s', (ticker, parsed) => {
    expect(parseCapTicker(ticker)).toEqual(parsed);
    expect(capTickerText(parsed as never)).toBe(ticker.toUpperCase());
  });

  it.each(['TOTAL.D', 'OTHERSBTC.D', 'BTC-USD', '', 'X.D.D'])('has no %s', (ticker) => {
    expect(parseCapTicker(ticker)).toBeNull();
  });

  it("uses TradingView's names, dominance included", () => {
    const name = (ticker: string) => capDescription(parseCapTicker(ticker) as never);
    expect(name('TOTAL')).toBe('Crypto Total Market Cap, $');
    expect(name('TOTAL2')).toBe('Crypto Total Market Cap Excluding BTC, $');
    expect(name('TOTAL3ES')).toBe('Crypto Total Market Cap Excluding BTC, ETH and Stablecoins, $');
    expect(name('OTHERS')).toBe('Crypto Total Market Cap Excluding Top 10, $');
    expect(name('STABLE.C')).toBe('Crypto Stablecoins Market Cap, $');
    expect(name('OTHERSBTC')).toBe('Ratio Total Market Cap Excluding Top 10 to BTC');
    expect(name('BTC')).toBe('Market Cap BTC, $');
    expect(name('BTC.D')).toBe('Market Cap BTC Dominance, %');
    expect(name('OTHERS.D')).toBe('Crypto Total Market Cap Excluding Top 10 Dominance, %');
  });
});

/** A coin worth `cap` at its open and close, twice that at its high and half at its low. */
const coin = (id: string, cap: number, stable = false): CoinCapBar => ({
  id,
  open: cap,
  high: cap * 2,
  low: cap / 2,
  close: cap,
  volume: 1,
  stable,
});

describe('compositeBars', () => {
  // 130 coins: bitcoin 1000, ethereum 500, then 128 coins of 128 down to 1; two stablecoins.
  const coins = [
    coin('bitcoin', 1000),
    coin('ethereum', 500),
    ...Array.from({ length: 128 }, (_, i) => coin(`c${i + 1}`, 128 - i, i === 0 || i === 127)),
  ];
  const sumOf = (from: number, to: number) => {
    let total = 0;
    for (let cap = from; cap >= to; cap--) total += cap;
    return total;
  };
  const values = compositeBars(coins);

  it('adds up the 125 largest for TOTAL, leaving Bitcoin out of TOTAL2 and Ethereum of TOTAL3', () => {
    // The 125 largest: bitcoin, ethereum and c1..c123 (128 down to 6).
    expect(values.TOTAL.close).toBe(1500 + sumOf(128, 6));
    expect(values.TOTAL2.close).toBe(500 + sumOf(128, 6));
    expect(values.TOTAL3.close).toBe(sumOf(128, 6));
  });

  it('leaves the top 10 out of OTHERS and ranks 1–50 and 1–100 out of TOTALE50 and TOTALE100', () => {
    // Ranks 11–125 are c9..c123: 120 down to 6.
    expect(values.OTHERS.close).toBe(sumOf(120, 6));
    // Ranks 51–125: c49..c123 (80 down to 6); 101–125: c99..c123 (30 down to 6).
    expect(values.TOTALE50.close).toBe(sumOf(80, 6));
    expect(values.TOTALE100.close).toBe(sumOf(30, 6));
  });

  it('leaves stablecoins out of the ES composites, and STABLE.C counts them beyond the top 125', () => {
    // c1 (128) is a member and a stablecoin; c128 (1) is a stablecoin outside the top 125.
    expect(values.TOTALES.close).toBe(1500 + sumOf(127, 6));
    expect(values.TOTAL2ES.close).toBe(500 + sumOf(127, 6));
    expect(values.TOTAL3ES.close).toBe(sumOf(127, 6));
    expect(values['STABLE.C'].close).toBe(128 + 1);
  });

  it('adds up opens, highs, lows and closes each on their own', () => {
    const two = compositeBars([coin('bitcoin', 10), coin('ethereum', 20)]);
    expect(two.TOTAL).toEqual({ open: 30, high: 60, low: 15, close: 30, volume: 2 });
  });

  it('ranks by close, ties by id, and leaves out coins without a market cap', () => {
    const ranked = compositeBars([
      ...Array.from({ length: 10 }, (_, i) => coin(`big${i}`, 100)),
      coin('b', 5),
      coin('a', 5),
      coin('gone', 0),
    ]);
    expect(ranked.OTHERS.close).toBe(10);
  });
});

describe('divideBars', () => {
  it('divides part by part and makes the high and low the extremes', () => {
    const bar = divideBars(
      { open: 10, high: 12, low: 8, close: 11, volume: 3 },
      { open: 100, high: 200, low: 50, close: 110, volume: 9 },
      100,
    );
    // open 10%, high 6%, low 16%, close 10%: the high is 16 and the low 6.
    expect(bar?.open).toBeCloseTo(10, 9);
    expect(bar?.high).toBeCloseTo(16, 9);
    expect(bar?.low).toBeCloseTo(6, 9);
    expect(bar?.close).toBeCloseTo(10, 9);
    expect(bar?.volume).toBe(3);
  });

  it('gives nothing for a divisor without value', () => {
    const empty = { open: 0, high: 0, low: 0, close: 0, volume: 0 };
    expect(divideBars(empty, empty, 100)).toBeNull();
  });
});

describe('decimalsFor', () => {
  it.each([
    [60.73, 2],
    [10.67, 2],
    [6.876, 3],
    [3.033, 3],
    [0.1323, 4],
    [0.0092, 6],
    [0, 2],
  ])('shows %s to four significant digits: %i decimals', (value, decimals) => {
    expect(decimalsFor(value)).toBe(decimals);
  });
});

const entry = (
  exchange: string,
  ticker: string,
  base: string,
  quote: string,
  volumeUsd: number,
): CatalogEntry => ({
  exchange,
  ticker,
  base,
  quote,
  description: '',
  volumeUsd,
  live: true,
  kind: 'spot',
});

describe('PairBook', () => {
  const entries = [
    entry('KRAKEN', 'XRPUSD', 'XRP', 'USD', 9e9),
    entry('OKX', 'XRPUSDT', 'XRP', 'USDT', 5e8),
    entry('BINANCE', 'XRPUSDC', 'XRP', 'USDC', 3e8),
    entry('BINANCE', 'XRPUSDT', 'XRP', 'USDT', 1e9),
    entry('BINANCE', 'XRPBTC', 'XRP', 'BTC', 1e9),
    entry('BINANCE', 'TINYUSDT', 'TINY', 'USDT', 50_000),
    entry('COINBASE', 'USDTUSD', 'USDT', 'USD', 2e8),
  ];
  const book = new PairBook(() => entries);

  it("takes the first exchange's dollar pair, USDT before USD before USDC", () => {
    expect(book.pairFor('XRP')).toEqual({ exchange: 'BINANCE', ticker: 'XRPUSDT', quote: 'USDT' });
    expect(book.pairFor('usdt')).toEqual({ exchange: 'COINBASE', ticker: 'USDTUSD', quote: 'USD' });
  });

  it('skips pairs that trade under $100,000 a day, and coins nobody trades', () => {
    expect(book.pairFor('TINY')).toBeNull();
    expect(book.pairFor('NONE')).toBeNull();
  });

  it('moves on from a pair set aside', () => {
    const own = new PairBook(() => entries);
    own.reject({ exchange: 'BINANCE', ticker: 'XRPUSDT', quote: 'USDT' });
    expect(own.pairFor('XRP')).toEqual({ exchange: 'BINANCE', ticker: 'XRPUSDC', quote: 'USDC' });
  });
});

const DAY = 86_400;

describe('AnchorBook', () => {
  const day0 = Date.UTC(2026, 9, 10) / 1000;
  const chart = {
    // Price 1 then 2; supply 100 then 300 (caps 100 and 600).
    prices: [
      [day0 * 1000, 1],
      [(day0 + DAY) * 1000, 2],
    ] as [number, number][],
    caps: [
      [day0 * 1000, 100],
      [(day0 + DAY) * 1000, 600],
    ] as [number, number][],
    volumes: [],
  };

  it('gives the supply, cap and price between its points, in a straight line', () => {
    const book = new AnchorBook(tempDir('anchors'));
    book.setHistory('coin', chart, 0);
    expect(book.supplyAt('coin', day0 + DAY / 2)).toBe(200);
    expect(book.capAt('coin', day0 + DAY / 2)).toBe(350);
    expect(book.priceAt('coin', day0 + DAY / 4)).toBe(1.25);
    // Past the last point: its values; before the first: the first supply, but no market cap.
    expect(book.supplyAt('coin', day0 + 5 * DAY)).toBe(300);
    expect(book.supplyAt('coin', day0 - DAY)).toBe(100);
    expect(book.capAt('coin', day0 - DAY)).toBeNull();
    expect(book.supplyAt('other', day0)).toBeNull();
  });

  it("keeps one snapshot a day: the day's latest replaces an earlier one, not midnight's", () => {
    const book = new AnchorBook(tempDir('anchors'));
    book.setHistory('coin', chart, 0);
    const snapshot = (price: number, cap: number) => [
      { id: 'coin', symbol: 'C', name: 'C', rank: 1, price, cap, supply: cap / price, volume: 0 },
    ];
    book.record(snapshot(2, 620), (day0 + DAY + 3_600) * 1000);
    book.record(snapshot(2, 640), (day0 + DAY + 7_200) * 1000);
    // Midnight's point stays; the 02:00 snapshot replaced 01:00's.
    expect(book.capAt('coin', day0 + DAY)).toBe(600);
    expect(book.capAt('coin', day0 + DAY + 7_200)).toBe(640);
    expect(book.capAt('coin', day0 + DAY + 3_600)).toBe(620);
  });

  it('keeps every day however old, so its history grows a day each day', () => {
    const book = new AnchorBook(tempDir('anchors'));
    book.setHistory('coin', chart, 0);
    const snapshot = (cap: number) => [
      { id: 'coin', symbol: 'C', name: 'C', rank: 1, price: 2, cap, supply: cap / 2, volume: 0 },
    ];
    for (let day = 2; day <= 500; day++)
      book.record(snapshot(600 + day), (day0 + day * DAY) * 1000);
    // 500 days on, the first day is still there (CoinGecko's free plan gives a year).
    expect(book.firstSec('coin')).toBe(day0);
    expect(book.capAt('coin', day0)).toBe(100);
    expect(book.capAt('coin', day0 + 500 * DAY)).toBe(1100);
    expect(book.firstSec('other')).toBeNull();
  });

  it("fetching a coin's history again only replaces its span: older days and snapshots stay", () => {
    const book = new AnchorBook(tempDir('anchors'));
    book.setHistory('coin', chart, 0);
    const snapshot = [
      { id: 'coin', symbol: 'C', name: 'C', rank: 1, price: 2, cap: 640, supply: 320, volume: 0 },
    ];
    book.record(snapshot, (day0 + 20 * DAY) * 1000);
    book.setHistory(
      'coin',
      {
        prices: [
          [(day0 + 10 * DAY) * 1000, 3],
          [(day0 + 11 * DAY) * 1000, 3],
        ],
        caps: [
          [(day0 + 10 * DAY) * 1000, 900],
          [(day0 + 11 * DAY) * 1000, 900],
        ],
        volumes: [],
      },
      1,
    );
    expect(book.firstSec('coin')).toBe(day0);
    expect(book.capAt('coin', day0)).toBe(100);
    expect(book.capAt('coin', day0 + 10 * DAY)).toBe(900);
    expect(book.capAt('coin', day0 + 20 * DAY)).toBe(640);
  });

  it('saves its points and reads them back', async () => {
    const dir = tempDir('anchors');
    const book = new AnchorBook(dir);
    book.setHistory('coin', chart, 42);
    await book.flush();
    const saved = JSON.parse(readFileSync(join(dir, 'cryptocap', 'anchors.json'), 'utf8'));
    expect(saved.history).toEqual({ coin: 42 });
    const again = new AnchorBook(dir);
    await again.load();
    expect(again.hasHistory('coin')).toBe(true);
    expect(again.capAt('coin', day0 + DAY)).toBe(600);
  });
});

describe('CoinGeckoUsage', () => {
  it('counts calls by calendar month and reads the count back', async () => {
    const dir = tempDir('usage');
    let now = Date.UTC(2026, 9, 31, 23, 0);
    const usage = new CoinGeckoUsage(dir, () => now);
    await usage.load();
    usage.record();
    usage.record();
    expect(usage.used()).toBe(2);
    await usage.flush();
    const again = new CoinGeckoUsage(dir, () => now);
    await again.load();
    expect(again.used()).toBe(2);
    now = Date.UTC(2026, 10, 1, 0, 30);
    expect(again.used()).toBe(0);
    again.record();
    expect(again.used()).toBe(1);
  });

  it('slows down past 8,000 calls and stops past 9,500', () => {
    const usage = new CoinGeckoUsage(tempDir('usage'));
    expect(usage.level()).toBe('ok');
    for (let i = 0; i < SLOW_AFTER; i++) usage.record();
    expect(usage.level()).toBe('slow');
    for (let i = SLOW_AFTER; i < STOP_AFTER; i++) usage.record();
    expect(usage.level()).toBe('stop');
  });
});
