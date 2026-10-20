import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCatalog } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { UsListings } from '../src/stocks/UsListings.ts';
import { NASDAQ_LISTED, OTHER_LISTED } from './fixtures/usDirectory.ts';

const URLS = {
  nasdaq: 'https://directory.test/nasdaqlisted.txt',
  other: 'https://directory.test/otherlisted.txt',
};

function setup(options: { dataDir?: string; fail?: boolean } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'tn-us-listings-'));
  const requests: string[] = [];
  const warnings: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (options.fail) return new Response('down', { status: 503 });
    return new Response(url.endsWith('nasdaqlisted.txt') ? NASDAQ_LISTED : OTHER_LISTED);
  }) as typeof globalThis.fetch;
  const listings = new UsListings({
    dataDir,
    fetch,
    urls: URLS,
    onWarning: (w) => warnings.push(w),
  });
  return { listings, dataDir, requests, warnings };
}

describe('the US listings', () => {
  it('fetches the directory once, and is searchable straight after', async () => {
    const { listings, requests, warnings } = setup();
    await listings.ready(5_000);
    listings.close();
    expect(requests.sort()).toEqual([URLS.nasdaq, URLS.other]);
    expect(warnings).toEqual([
      'US listings: exchange code "Q" isn\'t known yet; its listings are left out',
    ]);
    expect(listings.get('NASDAQ', 'AAPL')).toMatchObject({ name: 'Apple Inc.', kind: 'stock' });
    expect(listings.get('NYSE', 'AAPL')).toBeUndefined();
    const spy = listings.entries().find((entry) => entry.ticker === 'SPY');
    expect(spy).toEqual({
      exchange: 'AMEX',
      ticker: 'SPY',
      base: 'SPY',
      quote: 'USD',
      description: 'State Street SPDR S&P 500 ETF Trust',
      volumeUsd: 0,
      live: true,
      kind: 'etf',
      exchangeName: 'NYSE Arca',
    });
    // A preferred has no known data symbol until Alpaca's list is in.
    expect(listings.entries().find((entry) => entry.ticker === 'JPM/PD')?.live).toBe(false);
    expect(listings.exchanges().map((exchange) => exchange.id)).toEqual([
      'NASDAQ',
      'NYSE',
      'AMEX',
      'CBOE',
      'TXSE',
    ]);
  });

  it('comes back from disk after a restart without fetching, and keeps it when a fetch fails', async () => {
    const first = setup();
    await first.listings.ready(5_000);
    first.listings.close();
    await new Promise((resolve) => setTimeout(resolve, 20)); // the save
    const saved = JSON.parse(readFileSync(join(first.dataDir, 'us-listings.json'), 'utf8'));
    expect(saved.listings).toHaveLength(first.listings.all().length);

    const again = setup({ dataDir: first.dataDir });
    await again.listings.ready(5_000);
    again.listings.close();
    expect(again.requests).toEqual([]);
    expect(again.listings.get('AMEX', 'DOG')?.name).toBe('ProShares Short Dow30');

    const offline = setup({ fail: true });
    await offline.listings.ready(50);
    offline.listings.close();
    expect(offline.listings.all()).toEqual([]);
    expect(offline.warnings[0]).toContain("Couldn't fetch the US listings");
  });

  it("learns from Alpaca's list which listings have data, and what preferreds are called there", async () => {
    const { listings } = setup();
    await listings.ready(5_000);
    listings.close();
    await listings.setAvailable(['AAPL', 'SPY', 'JPM.PRD', 'AAC.WS']);
    const live = (ticker: string) =>
      listings.entries().find((entry) => entry.ticker === ticker)?.live;
    expect(live('AAPL')).toBe(true);
    expect(live('JPM/PD')).toBe(true);
    expect(listings.get('NYSE', 'JPM/PD')?.dataSymbol).toBe('JPM.PRD');
    expect(listings.get('NYSE', 'AAC/W')?.dataSymbol).toBe('AAC.WS');
    expect(live('QQQ')).toBe(false); // not on the (made-up) list
  });

  it('ranks the most traded first', async () => {
    const { listings } = setup();
    await listings.ready(5_000);
    listings.close();
    await listings.setVolumes({ SPY: 30e9, DOG: 20e6, FBTC: 900e6 });
    const funds = searchCatalog(listings.entries(), { query: '', category: 'funds' }).matches;
    // Untraded ones follow, shorter tickers first, as for crypto.
    expect(funds.map((match) => match.ticker)).toEqual(['SPY', 'FBTC', 'DOG', 'QQQ', 'IBIT']);
  });
});
