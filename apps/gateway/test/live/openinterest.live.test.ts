import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bar } from '@tradingnerd/core';
import { afterAll, describe, expect, it } from 'vitest';
import { MarketService } from '../../src/market/MarketService.ts';
import { OpenInterestExchange } from '../../src/openinterest/OpenInterestExchange.ts';
import {
  BinanceOiSource,
  BybitOiSource,
  type OiSource,
  OkxOiSource,
} from '../../src/openinterest/sources.ts';
import { parseOiTicker } from '../../src/openinterest/symbols.ts';

// Talks to Binance's futures APIs and archive, Bybit and OKX. Skipped unless LIVE=1
// (`pnpm test:live`). Binance's APIs and Bybit turn some places away (a cloud machine got HTTP 451
// and 403 on 2026-11-07); run these on the Mac. Downloads go to a temporary folder, not data/.
const LIVE = process.env.LIVE === '1';

const CASES: { name: string; source: () => OiSource; symbol: string; exchange: string }[] = [
  {
    name: 'Binance USDⓈ-M',
    source: () => new BinanceOiSource(),
    exchange: 'BINANCE',
    symbol: 'BTCUSDT.P_OI',
  },
  {
    name: 'Binance COIN-M',
    source: () => new BinanceOiSource(),
    exchange: 'BINANCE',
    symbol: 'BTCUSD.P_OI',
  },
  {
    name: 'Bybit linear',
    source: () => new BybitOiSource(),
    exchange: 'BYBIT',
    symbol: 'BTCUSDT.P_OI',
  },
  {
    name: 'Bybit inverse',
    source: () => new BybitOiSource(),
    exchange: 'BYBIT',
    symbol: 'BTCUSD.P_OI',
  },
  { name: 'OKX', source: () => new OkxOiSource(), exchange: 'OKX', symbol: 'BTCUSDT.P_OI' },
];

describe.runIf(LIVE).each(CASES)('$name open interest, live', ({ source, exchange, symbol }) => {
  const contract = parseOiTicker(exchange, symbol);
  if (!contract) throw new Error(symbol);
  const own = source();

  it('has the open interest now, and 5-minute points up to it', async () => {
    const now = await own.current(contract);
    expect(now.value).toBeGreaterThan(0);
    expect(Math.abs(now.time - Date.now())).toBeLessThan(10 * 60_000);
    const points = await own.recent(contract, Date.now() - 86_400_000);
    expect(points.length).toBeGreaterThan(250);
    // Whole 5-minute steps. Binance's live API leaves one out now and then (COIN-M on the Mac on
    // 2026-11-10: steps of 10 and 15 minutes in a day), though its archive has every point (288 a
    // day, 6 to 9 November); the series fills those from the archive a day on.
    const steps = points.slice(1).map((p, i) => p.time - (points[i] as { time: number }).time);
    expect(steps.every((step) => step > 0 && step % 300_000 === 0)).toBe(true);
  }, 60_000);

  it("names a perpetual it doesn't list unknown", async () => {
    const nope = parseOiTicker(exchange, 'NOPENOPEUSDT.P_OI');
    if (!nope) throw new Error('nope');
    await expect(own.check(nope)).rejects.toMatchObject({ code: 'unknown_symbol' });
  }, 30_000);
});

describe.runIf(LIVE)('Binance Vision archive, live', () => {
  let dir = '';
  afterAll(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined));

  it('serves a chart of BTCUSDT open interest from the archive, a day behind', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tn-oi-live-'));
    const adapter = new OpenInterestExchange({
      exchange: 'BINANCE',
      name: 'Binance',
      source: new BinanceOiSource(),
      dataDir: dir,
    });
    const market = new MarketService([], { openInterest: [adapter] });
    const { bars } = await market.getBars('BINANCE:BTCUSDTPERP_OI', '1D', null, 30);
    await market.close();
    expect(bars.length).toBeGreaterThanOrEqual(28);
    expect(bars.every((bar) => bar.low > 0 && bar.high >= bar.low)).toBe(true);
    // Each close is the next bar's open: the same 00:00 point.
    expect(bars.slice(1).every((bar, i) => bar.open === (bars[i] as Bar).close)).toBe(true);
  }, 120_000);
});
