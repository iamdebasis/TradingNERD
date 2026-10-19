import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_WATCHLIST,
  PROTOCOL_VERSION,
  parseExchangeList,
  parseLogoStatus,
  parseServerMessage,
  parseSymbolSearchResponse,
  type ServerMessage,
} from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SymbolCatalog } from '../src/catalog/SymbolCatalog.ts';
import type { GatewayConfig } from '../src/config.ts';
import { CoinGeckoClient } from '../src/logos/coingecko.ts';
import { LogoService } from '../src/logos/LogoService.ts';
import { SecretStore } from '../src/logos/secrets.ts';
import { MarketService } from '../src/market/MarketService.ts';
import { buildServer } from '../src/server.ts';
import { WatchlistStore } from '../src/storage/WatchlistStore.ts';
import { FakeCatalogSource, pair } from './helpers/FakeCatalog.ts';
import { fakeCoinGecko } from './helpers/FakeCoinGecko.ts';
import { dailyBars, FAKE_INFO, FakeExchange } from './helpers/FakeExchange.ts';

const UI_ORIGIN = 'http://127.0.0.1:5173';
const SYMBOL = 'FAKE:XRPUSDT';
const LAST = Date.UTC(2026, 9, 18) / 1000;
const config: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  allowedOrigins: [UI_ORIGIN],
  logLevel: 'silent',
  binance: { restUrl: undefined, streamUrl: undefined },
  bybit: { restUrl: undefined, streamUrl: undefined },
  okx: { restUrl: undefined, streamUrl: undefined, businessStreamUrl: undefined },
  coinbase: { restUrl: undefined, streamUrl: undefined },
  kraken: { restUrl: undefined, streamUrl: undefined },
  dataDir: '', // each server gets its own temporary directory
};

async function start() {
  const fake = new FakeExchange();
  fake.bars = dailyBars(10, LAST);
  // Not created yet: the gateway makes it on the first write.
  const dataDir = join(mkdtempSync(join(tmpdir(), 'tradingnerd-test-')), 'data');
  const coingecko = fakeCoinGecko({
    tickers: [['LINK', 'chainlink']],
    coins: [['chainlink', 'link']],
  });
  const logos = new LogoService({
    client: new CoinGeckoClient({ fetch: coingecko.fetch }),
    secrets: new SecretStore(dataDir, {}),
    dataDir,
    fetch: coingecko.fetch,
    paceMs: 0,
  });
  const catalog = new SymbolCatalog({
    sources: [
      new FakeCatalogSource('FAKE', 'Fake Exchange', [
        pair('XRPUSDT', 'XRP', 'USDT', 9e7, 1.3),
        pair('XRPBTC', 'XRP', 'BTC', 10, 0.0000158),
        pair('BTCUSDT', 'BTC', 'USDT', 9e8, 82_000),
      ]),
      new FakeCatalogSource('OTHER', 'Other Exchange', [pair('XRPUSDT', 'XRP', 'USDT', 2e7, 1.3)]),
    ],
    live: new Set(['FAKE']),
    dataDir,
  });
  const app = await buildServer(
    { ...config, dataDir },
    {
      market: new MarketService([fake], { emitIntervalMs: 0, quoteIntervalMs: 0 }),
      catalog,
      watchlist: new WatchlistStore(dataDir),
      logos,
    },
  );
  app.addHook('onClose', async () => catalog.close());
  return { app, fake, dataDir, logos };
}

describe('gateway HTTP', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await start());
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:5180', ...headers } });

  it('reports health', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', protocolVersion: PROTOCOL_VERSION });
    expect(Math.abs(res.json().serverTime - Date.now())).toBeLessThan(5_000);
  });

  it('accepts the UI origin and rejects a foreign one', async () => {
    expect((await get('/api/health', { origin: UI_ORIGIN })).statusCode).toBe(200);
    const res = await get('/api/health', { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_origin' });
  });

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const res = await get('/api/health', { host: 'evil.example:5180' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_host' });
  });

  it('sends no CORS headers', async () => {
    const res = await get('/api/health', { origin: UI_ORIGIN });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('resolves a symbol', async () => {
    const res = await get(`/api/symbols/resolve?symbol=${SYMBOL}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FAKE_INFO);
  });

  it.each([
    ['a missing symbol', '/api/symbols/resolve', 400, 'bad_request'],
    ['a malformed symbol', '/api/symbols/resolve?symbol=nonsense', 400, 'bad_request'],
    ['an unknown symbol', '/api/symbols/resolve?symbol=FAKE:NOPE', 404, 'unknown_symbol'],
    ['an unknown exchange', '/api/symbols/resolve?symbol=NOPE:XRPUSDT', 404, 'unknown_symbol'],
  ])('answers %s with a clear error', async (_label, url, status, code) => {
    const res = await get(url);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code });
    expect(typeof res.json().message).toBe('string');
  });

  it('serves bars before an exclusive end time', async () => {
    const res = await get(`/api/bars?symbol=${SYMBOL}&resolution=1D&to=${LAST}&countBack=2`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bars.map((bar: { time: number }) => bar.time)).toEqual([
      LAST - 172_800,
      LAST - 86_400,
    ]);
    expect(body.hasMore).toBe(true);
  });

  it('defaults to the latest bars', async () => {
    const res = await get(`/api/bars?symbol=${SYMBOL}&resolution=1D`);
    expect(res.json().bars.at(-1).time).toBe(LAST);
    expect(res.json().hasMore).toBe(false); // only 10 fake bars exist
  });

  it.each([
    ['a missing resolution', `/api/bars?symbol=${SYMBOL}`, 400, 'bad_request'],
    [
      'a non-numeric to',
      `/api/bars?symbol=${SYMBOL}&resolution=1D&to=yesterday`,
      400,
      'bad_request',
    ],
    [
      'a zero countBack',
      `/api/bars?symbol=${SYMBOL}&resolution=1D&countBack=0`,
      400,
      'bad_request',
    ],
    [
      'a huge countBack',
      `/api/bars?symbol=${SYMBOL}&resolution=1D&countBack=99999`,
      400,
      'bad_request',
    ],
    [
      'an unsupported resolution',
      `/api/bars?symbol=${SYMBOL}&resolution=30S`,
      400,
      'unsupported_resolution',
    ],
  ])('answers %s with a clear error', async (_label, url, status, code) => {
    const res = await get(url);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code });
  });
});

describe('gateway symbol search', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await start());
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:5180' } });

  it('finds pairs across exchanges, one match per ticker, live exchanges first', async () => {
    const res = await get('/api/symbols/search?query=xrp');
    expect(res.statusCode).toBe(200);
    const body = parseSymbolSearchResponse(res.json());
    expect(body?.hasMore).toBe(false);
    expect(body?.matches.map((match) => match.ticker)).toEqual(['XRPUSDT', 'XRPBTC']);
    expect(body?.matches[0]?.listings).toEqual([
      { id: 'FAKE:XRPUSDT', exchange: 'FAKE', live: true },
      { id: 'OTHER:XRPUSDT', exchange: 'OTHER', live: false },
    ]);
  });

  it('filters by source and pages through results', async () => {
    const other = parseSymbolSearchResponse(
      (await get('/api/symbols/search?query=XRP&exchange=other')).json(),
    );
    expect(other?.matches.map((match) => match.listings.map((listing) => listing.id))).toEqual([
      ['OTHER:XRPUSDT'],
    ]);
    const page = parseSymbolSearchResponse(
      (await get('/api/symbols/search?limit=1&offset=1')).json(),
    );
    expect(page?.matches).toHaveLength(1);
    expect(page?.hasMore).toBe(true);
  });

  it('refuses malformed parameters', async () => {
    for (const query of [
      'limit=0',
      'limit=101',
      'offset=-1',
      'type=futures',
      'exchange=b%20x',
      `query=${'x'.repeat(65)}`,
    ]) {
      const res = await get(`/api/symbols/search?${query}`);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe('bad_request');
    }
  });

  it('lists the exchanges, saying which have live data', async () => {
    const res = await get('/api/exchanges');
    expect(parseExchangeList(res.json())).toEqual({
      exchanges: [
        { id: 'FAKE', name: 'Fake Exchange', live: true },
        { id: 'OTHER', name: 'Other Exchange', live: false },
      ],
    });
  });
});

describe('gateway WebSocket', () => {
  let app: FastifyInstance;
  let fake: FakeExchange;
  let url: string;
  beforeAll(async () => {
    ({ app, fake } = await start());
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });
  afterAll(async () => {
    await app.close();
  });

  /** Opens a socket and returns a reader that yields the next parsed server message. */
  function connect(origin = UI_ORIGIN) {
    const ws = new WebSocket(url, { origin });
    const queue: ServerMessage[] = [];
    const waiters: ((message: ServerMessage) => void)[] = [];
    ws.on('message', (data) => {
      const message = parseServerMessage(String(data));
      if (!message) throw new Error(`unparseable server message: ${String(data)}`);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    });
    const next = () =>
      new Promise<ServerMessage>((resolve) => {
        const queued = queue.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      });
    const send = (message: unknown) =>
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    return { ws, next, send, queue };
  }

  it('greets with hello and answers ping with pong', async () => {
    const { ws, next, send } = connect();
    expect(await next()).toMatchObject({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    send({ type: 'ping', t: 42 });
    expect(await next()).toEqual({ type: 'pong', t: 42 });
    ws.close();
  });

  it('answers malformed messages with an error and keeps the connection', async () => {
    const { ws, next, send } = connect();
    await next(); // hello
    send('not json');
    expect(await next()).toMatchObject({ type: 'error', id: null, code: 'bad_request' });
    send({ type: 'ping', t: 7 });
    expect(await next()).toEqual({ type: 'pong', t: 7 });
    ws.close();
  });

  it('streams live bars for a subscription until it is cancelled', async () => {
    const { ws, next, send, queue } = connect();
    await next(); // hello
    send({ type: 'subscribe', id: 'b1', channel: 'bars', symbol: SYMBOL, resolution: '1D' });
    expect(await next()).toEqual({ type: 'status', id: 'b1', state: 'live' });
    expect(await next()).toMatchObject({ type: 'bar', id: 'b1', bar: { time: LAST, close: 1.1 } });

    fake.emitTrade({ price: 1.25, quantity: 3, time: LAST * 1000 + 60_000 });
    expect(await next()).toMatchObject({
      type: 'bar',
      id: 'b1',
      bar: { close: 1.25 },
      historical: false,
    });

    send({ type: 'unsubscribe', id: 'b1' });
    send({ type: 'ping', t: 1 });
    expect(await next()).toEqual({ type: 'pong', t: 1 });
    expect(fake.activeStreams()).toBe(0);
    fake.emitTrade({ price: 9, quantity: 1, time: LAST * 1000 + 61_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queue).toEqual([]);
    ws.close();
  });

  it('streams best bid and ask', async () => {
    const { ws, next, send } = connect();
    await next();
    send({ type: 'subscribe', id: 'k1', channel: 'book', symbol: SYMBOL });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.emitBook({ bid: 1.2955, ask: 1.2956 });
    expect(await next()).toEqual({ type: 'status', id: 'k1', state: 'live' });
    expect(await next()).toEqual({ type: 'book', id: 'k1', bid: 1.2955, ask: 1.2956 });
    ws.close();
  });

  it('streams watchlist quotes: the live price against the previous daily close', async () => {
    const { ws, next, send } = connect();
    await next(); // hello
    send({ type: 'subscribe', id: 'q1', channel: 'quotes', symbol: SYMBOL });
    expect(await next()).toEqual({ type: 'status', id: 'q1', state: 'live' });
    // dailyBars(10, LAST): the previous day closed at 1.09, today's bar stands at 1.1.
    expect(await next()).toEqual({ type: 'quote', id: 'q1', last: 1.1, prevClose: 1.09 });
    send({ type: 'unsubscribe', id: 'q1' });
    ws.close();
  });

  it('reports subscription errors with the subscription id', async () => {
    const { ws, next, send } = connect();
    await next();
    send({ type: 'subscribe', id: 'x1', channel: 'bars', symbol: 'FAKE:NOPE', resolution: '1D' });
    expect(await next()).toMatchObject({ type: 'error', id: 'x1', code: 'unknown_symbol' });
    send({ type: 'subscribe', id: 'x2', channel: 'bars', symbol: SYMBOL, resolution: '30S' });
    expect(await next()).toMatchObject({ type: 'error', id: 'x2', code: 'unsupported_resolution' });
    ws.close();
  });

  it('rejects a reused subscription id', async () => {
    const { ws, next, send } = connect();
    await next();
    const subscribe = { type: 'subscribe', id: 'd1', channel: 'book', symbol: SYMBOL };
    send(subscribe);
    send(subscribe);
    expect(await next()).toMatchObject({ type: 'error', id: 'd1', code: 'bad_request' });
    ws.close();
  });

  it('releases every upstream feed when the UI disconnects', async () => {
    const { ws, next, send } = connect();
    await next();
    send({ type: 'subscribe', id: 'r1', channel: 'bars', symbol: SYMBOL, resolution: '1D' });
    send({ type: 'subscribe', id: 'r2', channel: 'book', symbol: SYMBOL });
    await next(); // status live for r1
    expect(fake.activeStreams()).toBe(3);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.activeStreams()).toBe(0);
  });

  it('refuses the handshake from a foreign origin and hangs up', async () => {
    const ws = new WebSocket(url, { origin: 'https://evil.example' });
    ws.on('error', () => {}); // the aborted handshake is expected
    const result = await new Promise<{ status: number | undefined; closed: boolean }>((resolve) => {
      ws.on('open', () => resolve({ status: 101, closed: false }));
      ws.on('unexpected-response', (_req, res) => {
        // The gateway must close the connection after the 403. If it leaked the socket,
        // 'close' would never fire and this test would time out.
        const done = () => resolve({ status: res.statusCode, closed: true });
        if (res.socket.destroyed) done();
        else res.socket.once('close', done);
        res.resume();
      });
    });
    expect(result).toEqual({ status: 403, closed: true });
  });
});

describe('gateway watchlist', () => {
  let app: FastifyInstance;
  let dataDir: string;
  beforeAll(async () => {
    ({ app, dataDir } = await start());
  });
  afterAll(async () => {
    await app.close();
  });

  const request = (method: 'GET' | 'PUT', payload?: unknown) =>
    app.inject({
      method,
      url: '/api/watchlist',
      headers: { host: '127.0.0.1:5180', origin: UI_ORIGIN },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  it("starts from the user's TradingView coins", async () => {
    const res = await request('GET');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULT_WATCHLIST);
  });

  it('saves a watchlist, normalized, and serves it back', async () => {
    const res = await request('PUT', {
      sections: [
        {
          id: 'crypto',
          title: 'Crypto',
          collapsed: true,
          symbols: ['binance:opusdt', 'BINANCE:XRPUSDT'],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const saved = {
      sections: [
        {
          id: 'crypto',
          title: 'Crypto',
          collapsed: true,
          symbols: ['BINANCE:OPUSDT', 'BINANCE:XRPUSDT'],
        },
      ],
    };
    expect(res.json()).toEqual(saved);
    expect((await request('GET')).json()).toEqual(saved);
    const file = join(dataDir, 'watchlist.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses something that is not a watchlist, keeping what was saved', async () => {
    const before = (await request('GET')).json();
    const res = await request('PUT', {
      sections: [{ id: 'x', title: 'X', collapsed: false, symbols: ['nope'] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
    expect((await request('GET')).json()).toEqual(before);
  });

  it('moves an unreadable file aside instead of losing it', async () => {
    writeFileSync(join(dataDir, 'watchlist.json'), '{ broken');
    expect((await request('GET')).json()).toEqual(DEFAULT_WATCHLIST);
    const kept = readdirSync(dataDir).filter((name) => name.startsWith('watchlist.json.invalid-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dataDir, kept[0] as string), 'utf8')).toBe('{ broken');
  });

  it('keeps the data folder private to the user', () => {
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });
});

describe('gateway logos', () => {
  let app: FastifyInstance;
  let logos: LogoService;
  beforeAll(async () => {
    ({ app, logos } = await start());
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: '127.0.0.1:5180', origin: UI_ORIGIN },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  it('starts without a key, and without logos', async () => {
    const status = await call('GET', '/api/logos/status');
    expect(parseLogoStatus(status.json())).toEqual({
      key: null,
      promptDismissed: false,
      syncedAt: null,
      syncing: false,
      syncError: null,
    });
    const logo = await call('GET', '/api/logos/coin/BINANCE/LINK');
    expect(logo.statusCode).toBe(204);
  });

  it('refuses a key CoinGecko rejects, with the reason', async () => {
    const res = await call('PUT', '/api/logos/key', { key: 'CG-wrong-key-0000' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'CoinGecko rejected this key' });
  });

  it('takes a working key, shows it masked, and serves logos once synced', async () => {
    const res = await call('PUT', '/api/logos/key', { key: 'CG-demo-key-3f9a' });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toEqual({ masked: '••••3f9a', plan: 'demo', source: 'file' });
    expect(res.body).not.toContain('CG-demo-key');
    await logos.whenIdle();
    const logo = await call('GET', '/api/logos/coin/binance/link');
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['x-content-type-options']).toBe('nosniff');
    for (const url of ['/api/logos/status', '/api/watchlist', '/api/health']) {
      expect((await call('GET', url)).body).not.toContain('CG-demo-key');
    }
  });

  it('remembers a skipped prompt and removes the key', async () => {
    expect((await call('POST', '/api/logos/prompt-dismissed')).json().promptDismissed).toBe(true);
    expect((await call('DELETE', '/api/logos/key')).json().key).toBeNull();
  });
});
