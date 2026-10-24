import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SymbolCatalog } from '../src/catalog/SymbolCatalog.ts';
import type { GatewayConfig } from '../src/config.ts';
import { CoinGeckoClient } from '../src/logos/coingecko.ts';
import { LogoService } from '../src/logos/LogoService.ts';
import { MarketService } from '../src/market/MarketService.ts';
import { buildServer } from '../src/server.ts';
import { UsListings } from '../src/stocks/UsListings.ts';
import { UsStocksMarket } from '../src/stocks/UsStocksMarket.ts';
import { FlagStore } from '../src/storage/FlagStore.ts';
import { SecretStore } from '../src/storage/secrets.ts';
import { WatchlistStore } from '../src/storage/WatchlistStore.ts';
import { NASDAQ_LISTED, OTHER_LISTED } from './fixtures/usDirectory.ts';
import { createFakeAlpaca } from './helpers/fakeAlpaca.ts';

const config: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  allowedOrigins: ['http://127.0.0.1:5173'],
  logLevel: 'silent',
  binance: { restUrl: undefined, streamUrl: undefined },
  bybit: { restUrl: undefined, streamUrl: undefined },
  okx: { restUrl: undefined, streamUrl: undefined, businessStreamUrl: undefined },
  coinbase: { restUrl: undefined, streamUrl: undefined },
  kraken: { restUrl: undefined, streamUrl: undefined },
  alpaca: { dataUrl: undefined, tradingUrl: undefined, streamUrl: undefined },
  usListingsUrl: undefined,
  dataDir: '',
};
const KEY_ID = 'PKTESTKEYID123456789';
const SECRET = 'testsecret0000000000000000000000000000000';

describe('the gateway with US stocks', () => {
  let app: FastifyInstance;
  let dataDir: string;
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tn-stock-routes-'));
    const alpaca = createFakeAlpaca({ now: () => Date.now() });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('nasdaqtrader.com')) {
        return new Response(url.includes('nasdaqlisted') ? NASDAQ_LISTED : OTHER_LISTED);
      }
      return alpaca.fetch(input, init);
    }) as typeof globalThis.fetch;
    const secrets = new SecretStore(dataDir, {});
    const listings = new UsListings({ dataDir, fetch });
    const stocks = new UsStocksMarket({
      dataDir,
      secrets,
      listings,
      fetch,
      streamUrl: 'ws://127.0.0.1:9',
      sleep: async () => {},
    });
    const catalog = new SymbolCatalog({ sources: [], extra: listings, live: new Set(), dataDir });
    app = await buildServer(
      { ...config, dataDir },
      {
        market: new MarketService([...stocks.exchanges()]),
        catalog,
        watchlist: new WatchlistStore(dataDir),
        flags: new FlagStore(dataDir),
        logos: new LogoService({ client: new CoinGeckoClient({ fetch }), secrets, dataDir, fetch }),
        stocks,
      },
    );
    app.addHook('onClose', async () => {
      catalog.close();
      stocks.close();
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: '127.0.0.1:5180' },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  it('takes an Alpaca key, checked and masked, and removes it', async () => {
    expect((await call('GET', '/api/stocks/key')).json()).toEqual({
      configured: false,
      source: null,
      keyId: null,
      sip: null,
    });
    const bad = await call('PUT', '/api/stocks/key', { keyId: 'nope', secret: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('bad_request');

    const saved = await call('PUT', '/api/stocks/key', { keyId: ` ${KEY_ID} `, secret: SECRET });
    expect(saved.statusCode).toBe(200);
    // The fake is on the free plan: the whole market, 15 minutes late.
    expect(saved.json()).toEqual({
      configured: true,
      source: 'file',
      keyId: '••••6789',
      sip: 'delayed',
    });
    expect(saved.body).not.toContain(SECRET);
    const file = join(dataDir, 'secrets.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).alpaca).toEqual({
      keyId: KEY_ID,
      secret: SECRET,
      sip: 'delayed',
    });

    expect((await call('DELETE', '/api/stocks/key')).json().configured).toBe(false);
  });

  it('finds stocks and funds in the search, under their tabs', async () => {
    const funds = await call('GET', '/api/symbols/search?query=SPY&category=funds');
    expect(funds.json().matches[0]).toEqual({
      ticker: 'SPY',
      base: 'SPY',
      quote: 'USD',
      description: 'State Street SPDR S&P 500 ETF Trust',
      type: 'etf',
      listings: [{ id: 'AMEX:SPY', exchange: 'AMEX', live: true, exchangeName: 'NYSE Arca' }],
    });
    const stocks = await call('GET', '/api/symbols/search?query=brk.b&category=stocks');
    expect(stocks.json().matches[0]?.listings[0]?.id).toBe('NYSE:BRK.B');
    expect((await call('GET', '/api/symbols/search?category=bonds')).statusCode).toBe(400);
    const exchanges = (await call('GET', '/api/exchanges')).json().exchanges;
    expect(exchanges.map((exchange: { id: string }) => exchange.id)).toEqual([
      'NASDAQ',
      'NYSE',
      'AMEX',
      'CBOE',
      'TXSE',
    ]);
  });
});
