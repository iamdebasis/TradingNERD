import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SymbolCatalog } from '../src/catalog/SymbolCatalog.ts';
import type { GatewayConfig } from '../src/config.ts';
import { LiveCoinWatchClient } from '../src/cryptocap/livecoinwatch.ts';
import { OlderCaps } from '../src/cryptocap/older.ts';
import { CoinGeckoClient } from '../src/logos/coingecko.ts';
import { LogoService } from '../src/logos/LogoService.ts';
import { MarketService } from '../src/market/MarketService.ts';
import { buildServer } from '../src/server.ts';
import { FlagStore } from '../src/storage/FlagStore.ts';
import { SecretStore } from '../src/storage/secrets.ts';
import { WatchlistsStore } from '../src/storage/WatchlistsStore.ts';
import { fakeLiveCoinWatch } from './helpers/FakeLiveCoinWatch.ts';

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
  bitstamp: { restUrl: undefined, streamUrl: undefined },
  alpaca: { dataUrl: undefined, tradingUrl: undefined, streamUrl: undefined },
  usListingsUrl: undefined,
  livecoinwatchUrl: undefined,
  dataDir: '',
};
const DAY = 86_400_000;
const KEY = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
/** Our history's first day here. */
const JOIN = Date.UTC(2025, 9, 26);

describe('the gateway with older market caps', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let older: OlderCaps;
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tn-older-routes-'));
    const lcw = fakeLiveCoinWatch({ cap: () => 2e12, keys: [KEY] });
    const secrets = new SecretStore(dataDir, {});
    older = new OlderCaps({
      secrets,
      dataDir,
      joinMs: () => JOIN,
      ours: async () => null,
      client: new LiveCoinWatchClient({ url: 'http://lcw.test', fetch: lcw.fetch }),
      originMs: JOIN - 8 * DAY,
      gapMs: 0,
      sleep: async () => {},
    });
    const catalog = new SymbolCatalog({ sources: [], live: new Set(), dataDir });
    const fetch = (async () => new Response('{}', { status: 404 })) as typeof globalThis.fetch;
    app = await buildServer(
      { ...config, dataDir },
      {
        market: new MarketService([]),
        catalog,
        watchlist: new WatchlistsStore(dataDir),
        flags: new FlagStore(dataDir),
        logos: new LogoService({ client: new CoinGeckoClient({ fetch }), secrets, dataDir, fetch }),
        olderCaps: older,
      },
    );
    app.addHook('onClose', async () => {
      catalog.close();
      await older.close();
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

  it('takes a Live Coin Watch key, checked and masked, downloads with it, and removes it', async () => {
    expect((await call('GET', '/api/older-caps')).json()).toEqual({
      key: null,
      state: 'none',
      progress: 0,
      from: null,
      until: null,
      message: null,
    });
    const empty = await call('PUT', '/api/older-caps/key', { key: 42 });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({
      error: 'bad_request',
      message: 'Enter your Live Coin Watch key',
    });
    const bad = await call('PUT', '/api/older-caps/key', { key: 'not-a-key' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      error: 'bad_request',
      message: 'Live Coin Watch rejected this key',
    });

    const saved = await call('PUT', '/api/older-caps/key', { key: ` ${KEY} ` });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().key).toEqual({ masked: '••••6789', source: 'file' });
    expect(saved.body).not.toContain(KEY);
    const file = join(dataDir, 'secrets.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).livecoinwatch).toEqual({ key: KEY });

    await older.idle();
    const done = (await call('GET', '/api/older-caps')).json();
    expect(done).toEqual({
      key: { masked: '••••6789', source: 'file' },
      state: 'done',
      progress: 1,
      from: '2025-10-18',
      until: '2025-10-29',
      message: null,
    });
    expect(JSON.stringify(done)).not.toContain(KEY);

    // Without the key, what came in stays.
    const removed = await call('DELETE', '/api/older-caps/key');
    expect(removed.json()).toMatchObject({ key: null, state: 'done', from: '2025-10-18' });
  });
});
