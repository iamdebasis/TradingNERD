import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketService } from '../src/market/MarketService.ts';
import { type CandleUpdate, type FeedState, MarketError } from '../src/market/types.ts';
import { oiBar, oiBarsBefore, oiBarsIn, withPolls } from '../src/openinterest/bars.ts';
import { OpenInterestExchange } from '../src/openinterest/OpenInterestExchange.ts';
import { type OiPoint, OiSeries, STEP_MS } from '../src/openinterest/series.ts';
import {
  type Backfill,
  BinanceOiSource,
  BybitOiSource,
  type OiSource,
  OkxOiSource,
} from '../src/openinterest/sources.ts';
import { type OiContract, parseOiTicker } from '../src/openinterest/symbols.ts';
import { unzipSingle } from '../src/openinterest/zip.ts';
import { dailyBars, FakeExchange } from './helpers/FakeExchange.ts';
import { zipOf } from './helpers/zip.ts';

const r = (text: string): Resolution => parseResolution(text) as Resolution;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** "Now" in these tests: Saturday 2026-11-07, 07:00 UTC. */
const NOW = Date.UTC(2026, 10, 7, 7);
const contract = (exchange: string, ticker: string): OiContract => {
  const parsed = parseOiTicker(exchange, ticker);
  if (!parsed) throw new Error(`${exchange}:${ticker}`);
  return parsed;
};

const dirs: string[] = [];
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tn-oi-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Open interest symbols, as TradingView names them (docs/SPEC.md §6.18)', () => {
  it('reads ".P_OI" tickers: the pair, how it is margined, the exchange’s own id and unit', () => {
    expect(parseOiTicker('BINANCE', 'BTCUSDT.P_OI')).toEqual({
      exchange: 'BINANCE',
      ticker: 'BTCUSDT.P_OI',
      pair: 'BTCUSDT',
      base: 'BTC',
      quote: 'USDT',
      margin: 'linear',
      providerId: 'BTCUSDT',
      unit: 'coin',
    });
    expect(parseOiTicker('BINANCE', 'BTCUSD.P_OI')).toMatchObject({
      margin: 'inverse',
      providerId: 'BTCUSD_PERP',
      unit: 'contracts',
    });
    expect(parseOiTicker('BINANCE', '1000PEPEUSDT.P_OI')?.base).toBe('1000PEPE');
    expect(parseOiTicker('BYBIT', 'BTCUSDT.P_OI')).toMatchObject({
      providerId: 'BTCUSDT',
      unit: 'coin',
    });
    expect(parseOiTicker('BYBIT', 'BTCUSD.P_OI')).toMatchObject({
      providerId: 'BTCUSD',
      unit: 'usd',
    });
    expect(parseOiTicker('BYBIT', 'BTCUSDC.P_OI')?.providerId).toBe('BTCPERP');
    expect(parseOiTicker('OKX', 'BTCUSDT.P_OI')).toMatchObject({
      providerId: 'BTC-USDT-SWAP',
      unit: 'contracts',
    });
    expect(parseOiTicker('OKX', 'btcusd.p_oi')?.providerId).toBe('BTC-USD-SWAP');
  });

  it("maps Binance's older names, which scripts still ask for, to the new ones", () => {
    // Your script's: "BINANCE:BTCUSDTPERP_OI", and "BINANCE:BTCPERP_OI" for coin-margined.
    expect(parseOiTicker('BINANCE', 'BTCUSDTPERP_OI')?.ticker).toBe('BTCUSDT.P_OI');
    expect(parseOiTicker('BINANCE', 'BTCPERP_OI')).toMatchObject({
      ticker: 'BTCUSD.P_OI',
      providerId: 'BTCUSD_PERP',
    });
    expect(parseOiTicker('BINANCE', 'ETHBUSDPERP_OI')?.ticker).toBe('ETHBUSD.P_OI');
  });

  it("isn't fooled by what isn't one", () => {
    expect(parseOiTicker('BINANCE', 'BTCUSDT')).toBeNull();
    expect(parseOiTicker('BINANCE', 'BTCUSDT_OI')).toBeNull();
    expect(parseOiTicker('BINANCE', 'USDT.P_OI')).toBeNull();
    expect(parseOiTicker('COINBASE', 'BTCUSD.P_OI')).toBeNull();
    expect(parseOiTicker('BYBIT', 'BTCPERP_OI')).toBeNull();
  });
});

describe("Binance Vision's zip files", () => {
  const CSV = 'create_time,symbol,sum_open_interest\n2026-11-04 00:00:00,BTCUSDT,98982.416\n';

  it('reads the one file in them, deflated or stored, its sizes where they are', () => {
    expect(unzipSingle(zipOf('a.csv', CSV))).toBe(CSV);
    expect(unzipSingle(zipOf('a.csv', CSV, { stored: true }))).toBe(CSV);
    expect(unzipSingle(zipOf('a.csv', CSV, { descriptor: true }))).toBe(CSV);
  });

  it('turns down anything else', () => {
    expect(() => unzipSingle(new TextEncoder().encode('<Error>NoSuchKey</Error>'))).toThrow(
      'not a zip',
    );
    const zip = zipOf('a.csv', CSV);
    expect(() => unzipSingle(zip.subarray(0, 40))).toThrow();
  });
});

describe('A series of open interest points (data/oi/)', () => {
  it('keeps points on its 5-minute grid, by month, and reads them back in order', async () => {
    const dir = await dataDir();
    const series = new OiSeries(dir);
    const end = Date.UTC(2026, 10, 1);
    series.put([
      { time: end - STEP_MS, value: 10 },
      { time: end, value: 11 },
      { time: end + 2 * STEP_MS + 61_000, value: 12 }, // off the grid: the step it falls in
    ]);
    const seen: [number, number][] = [];
    series.each(end - DAY, end + DAY, (time, value) => seen.push([time, value]));
    expect(seen).toEqual([
      [end - STEP_MS, 10],
      [end, 11],
      [end + 2 * STEP_MS, 12],
    ]);
    expect([series.first(), series.last()]).toEqual([end - STEP_MS, end + 2 * STEP_MS]);
    await series.save();
    expect((await readdir(dir)).sort()).toEqual(['2026-10.json', '2026-11.json']);
    const again = new OiSeries(dir);
    await again.load();
    const back: number[] = [];
    again.each(0, Number.POSITIVE_INFINITY, (_, value) => back.push(value));
    expect(back).toEqual([10, 11, 12]);
  });

  it('moves a month it can’t read aside, rather than overwrite it', async () => {
    const dir = await dataDir();
    await writeFile(
      join(dir, '2026-11.json'),
      '{"v":1,"month":"2026-11","step":300000,"values":[1]}',
    );
    const warnings: string[] = [];
    const series = new OiSeries(dir, (message) => warnings.push(message));
    await series.load();
    expect(series.first()).toBeNull();
    expect(warnings[0]).toMatch(/moved to/);
    expect((await readdir(dir)).some((name) => name.startsWith('2026-11.json.invalid-'))).toBe(
      true,
    );
  });
});

/** A point source from a list, as a series is one. */
function listOf(points: readonly OiPoint[]) {
  return {
    first: () => points[0]?.time ?? null,
    each(from: number, to: number, fn: (time: number, value: number) => void) {
      for (const p of points) if (p.time >= from && p.time <= to) fn(p.time, p.value);
    },
  };
}

describe('Open interest bars, made from its points (provisional, docs/SPEC.md §11)', () => {
  const D0 = Date.UTC(2026, 10, 1);
  const hourly = Array.from({ length: 72 }, (_, i) => ({ time: D0 + i * HOUR, value: 100 + i }));

  it('open at the first point, close at the one at their end, so each close is the next open', () => {
    const bars = oiBarsIn(listOf(hourly), r('1D'), D0, D0 + 3 * DAY, 10);
    expect(bars.map((b) => [b.open, b.high, b.low, b.close])).toEqual([
      [100, 124, 100, 124],
      [124, 148, 124, 148],
      [148, 171, 148, 171],
    ]);
    // Volume 1: a bar the gateway's resampling keeps (the symbol has no real volume).
    expect(bars.every((b) => b.volume === 1)).toBe(true);
  });

  it('need a point inside them: one only at the close starts the next bar', () => {
    expect(oiBar(listOf([{ time: D0 + DAY, value: 5 }]), D0, D0 + DAY)).toBeNull();
  });

  it('page back over gaps, so a page is short only where the points begin', () => {
    const gappy = [...hourly.slice(0, 24), ...hourly.slice(48)];
    const bars = oiBarsBefore(listOf(gappy), r('60'), D0 + 3 * DAY, 100, NOW);
    expect(bars).toHaveLength(48);
    expect(bars[0]?.time).toBe(D0 / 1000);
    expect(oiBarsBefore(listOf(gappy), r('60'), D0 + 3 * DAY, 30, NOW)[0]?.time).toBe(
      (D0 + 18 * HOUR) / 1000,
    );
  });

  it('take in the live polls after the points, in time order', () => {
    const polls = [
      { time: D0 + 71 * HOUR + 60_000, value: 200 },
      { time: D0 + 71 * HOUR + 120_000, value: 150 },
    ];
    const bar = oiBar(withPolls(listOf(hourly), polls), D0 + 71 * HOUR, D0 + 72 * HOUR);
    expect(bar).toMatchObject({ open: 171, high: 200, low: 150, close: 150 });
  });
});

// ---- the exchanges' sources, against fakes shaped as their replies were on 2026-11-07 ----

const HEADER =
  'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio';
/** The open interest at a time, in the fakes: one more coin every 5 minutes. */
const valueAt = (ms: number) => 1_000_000 + (ms - Date.UTC(2026, 0, 1)) / STEP_MS;

/** One archive day's CSV: every 5 minutes from 00:00, as Binance Vision writes them. */
function archiveCsv(
  symbol: string,
  day: string,
  options: { doubled?: boolean; shuffled?: boolean; zeroAt?: number } = {},
) {
  const start = Date.parse(`${day}T00:00:00Z`);
  let rows = Array.from({ length: 288 }, (_, i) => {
    const time = start + i * STEP_MS;
    const stamp = new Date(time).toISOString().replace('T', ' ').slice(0, 19);
    // Binance writes a failed reading as "0E-16".
    const sum = i === options.zeroAt ? '0E-16' : valueAt(time).toFixed(16);
    return `${stamp},${symbol},${sum},7671921994.1,2.4,1.7,2.3,1.0`;
  });
  if (options.doubled) rows = rows.flatMap((row) => [row, row]);
  if (options.shuffled)
    rows = [...rows.filter((_, i) => i % 2), ...rows.filter((_, i) => !(i % 2))];
  return `${HEADER}\n${rows.join('\n')}\n`;
}

interface FakeBinance {
  archive: Map<string, string>;
  hist: OiPoint[];
  refuse: boolean;
  calls: string[];
}

function binanceFetch(fake: FakeBinance): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    fake.calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === 'archive.test') {
      const match =
        /\/(um|cm)\/daily\/metrics\/([A-Z0-9_]+)\/\2-metrics-(\d{4}-\d{2}-\d{2})\.zip$/.exec(
          url.pathname,
        );
      const text = match ? fake.archive.get(`${match[2]}|${match[3]}`) : undefined;
      if (!text) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      const body = method === 'HEAD' ? null : zipOf(`${match?.[2]}-${match?.[3]}.csv`, text);
      return new Response(body, { status: 200 });
    }
    if (fake.refuse) {
      return Response.json(
        { code: 0, msg: 'Service unavailable from a restricted location' },
        { status: 451 },
      );
    }
    if (url.pathname === '/fapi/v1/openInterest' || url.pathname === '/dapi/v1/openInterest') {
      const symbol = url.searchParams.get('symbol');
      if (symbol !== 'BTCUSDT' && symbol !== 'BTCUSD_PERP') {
        return Response.json({ code: -1121, msg: 'Invalid symbol.' }, { status: 400 });
      }
      return Response.json({
        openInterest: symbol === 'BTCUSDT' ? '98982.416' : '15133453',
        symbol,
        time: NOW,
      });
    }
    if (url.pathname === '/futures/data/openInterestHist') {
      const start = Number(url.searchParams.get('startTime'));
      const end = Number(url.searchParams.get('endTime'));
      const limit = Number(url.searchParams.get('limit'));
      const rows = fake.hist
        .filter((p) => p.time >= start && p.time <= end)
        .slice(0, limit)
        .map((p) => ({
          symbol: 'BTCUSDT',
          sumOpenInterest: String(p.value),
          sumOpenInterestValue: '1',
          timestamp: p.time,
        }));
      return Response.json(rows);
    }
    return new Response('nothing here', { status: 404 });
  }) as typeof fetch;
}

function binance(fake: FakeBinance) {
  return new BinanceOiSource({
    futuresUrl: 'https://fapi.test',
    coinmUrl: 'https://dapi.test',
    archiveUrl: 'https://archive.test',
    fetch: binanceFetch(fake),
    now: () => NOW,
    paceMs: 0,
    retryDelaysMs: [],
  });
}

/** A Backfill that records what it's given. */
function recorder(first: string | null = null) {
  const points: OiPoint[] = [];
  const reached: number[] = [];
  const days = new Set<string>();
  let archiveFirst = first;
  const into: Backfill = {
    put: (more) => points.push(...more),
    reached: (ms) => reached.push(ms),
    archive: {
      first: () => archiveFirst,
      setFirst: (day) => {
        archiveFirst = day;
      },
      has: (day) => days.has(day),
      mark: (day) => days.add(day),
    },
  };
  return { into, points, reached, days, first: () => archiveFirst };
}

const UM = contract('BINANCE', 'BTCUSDT.P_OI');
const CM = contract('BINANCE', 'BTCUSD.P_OI');

describe('Binance: its futures APIs, and its archive at data.binance.vision', () => {
  const fake = (): FakeBinance => ({ archive: new Map(), hist: [], refuse: false, calls: [] });

  it('reads the open interest now: coins for USDⓈ-M, contracts for COIN-M', async () => {
    const source = binance(fake());
    expect(await source.current(UM)).toEqual({ time: NOW, value: 98_982.416 });
    expect(await source.current(CM)).toEqual({ time: NOW, value: 15_133_453 });
    await expect(source.current(contract('BINANCE', 'NOPEUSDT.P_OI'))).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
  });

  it('tells a perpetual from its archive where Binance turns this place away (HTTP 451)', async () => {
    const f = fake();
    f.refuse = true;
    f.archive.set('BTCUSDT|2026-11-06', archiveCsv('BTCUSDT', '2026-11-06'));
    const source = binance(f);
    await expect(source.check(UM)).resolves.toBeUndefined();
    await expect(source.check(contract('BINANCE', 'ETHUSDT.P_OI'))).rejects.toThrow(
      /refuses requests from here \(HTTP 451\)/,
    );
  });

  it('pages its 30 days of 5-minute points, 500 a request', async () => {
    const f = fake();
    // Its last 29 days, every 5 minutes up to now.
    f.hist = Array.from({ length: 29 * 288 }, (_, i) => {
      const time = NOW - (29 * 288 - i) * STEP_MS;
      return { time, value: valueAt(time) };
    });
    const points = await binance(f).recent(UM, 0);
    expect(points).toHaveLength(f.hist.length);
    expect(
      points.every((p, i) => i === 0 || p.time === (points[i - 1] as OiPoint).time + STEP_MS),
    ).toBe(true);
    // Its window holds 8,639 steps of 5 minutes: 18 requests of 500, and one for now itself.
    const pages = f.calls.filter((call) => call.includes('openInterestHist')).length;
    expect(pages).toBeGreaterThanOrEqual(18);
    expect(pages).toBeLessThanOrEqual(19);
  });

  it('downloads the archive newest day first, from its first day, found by bisection', async () => {
    const f = fake();
    for (let day = Date.UTC(2026, 9, 1); day <= Date.UTC(2026, 10, 5); day += DAY) {
      const name = new Date(day).toISOString().slice(0, 10);
      if (name === '2026-10-10') continue; // missing from the archive
      f.archive.set(
        `BTCUSDT|${name}`,
        archiveCsv('BTCUSDT', name, {
          doubled: name === '2026-10-03',
          shuffled: name === '2026-11-04',
          ...(name === '2026-10-15' ? { zeroAt: 164 } : {}),
        }),
      );
    }
    const record = recorder();
    await binance(f).backfill(UM, record.into, new AbortController().signal);
    expect(record.first()).toBe('2026-10-01');
    // About log2 of the days since September 2019 to find it.
    expect(f.calls.filter((call) => call.startsWith('HEAD')).length).toBeLessThan(20);
    // 35 days of 288 points, each once; the zero reading (13:40 on 2026-10-15) left out.
    expect(record.points).toHaveLength(35 * 288 - 1);
    expect(new Set(record.points.map((p) => p.time)).size).toBe(35 * 288 - 1);
    expect(record.points.some((p) => p.time === Date.UTC(2026, 9, 15, 13, 40))).toBe(false);
    expect(record.points.every((p) => p.value === valueAt(p.time))).toBe(true);
    // Newest first: how far back it's complete only goes down.
    expect(record.reached).toEqual([...record.reached].sort((a, b) => b - a));
    expect(record.reached.at(-1)).toBe(Date.UTC(2026, 9, 1));
    // A day long missing is noted as such; yesterday's, not yet published, isn't.
    expect(record.days.has('2026-10-10')).toBe(true);
    expect(record.days.has('2026-11-06')).toBe(false);
  });

  it('downloads only the days it doesn’t have yet', async () => {
    const f = fake();
    f.archive.set('BTCUSDT|2026-11-05', archiveCsv('BTCUSDT', '2026-11-05'));
    f.archive.set('BTCUSDT|2026-11-04', archiveCsv('BTCUSDT', '2026-11-04'));
    const record = recorder('2026-11-04');
    record.into.archive.mark('2026-11-04');
    await binance(f).backfill(UM, record.into, new AbortController().signal);
    expect(f.calls.filter((call) => call.startsWith('GET'))).toEqual([
      'GET archive.test/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2026-11-06.zip',
      'GET archive.test/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2026-11-05.zip',
    ]);
  });
});

describe('Bybit: its open interest at 5 minutes, an hour and a day, paged by cursor', () => {
  /** Bybit's open-interest list for a step, newest first, 200 a page. */
  function bybitFetch(points: Record<string, OiPoint[]>, calls: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}?${url.searchParams.get('intervalTime') ?? ''}`);
      const symbol = url.searchParams.get('symbol');
      if (symbol !== 'BTCUSDT') {
        return Response.json({
          retCode: 10001,
          retMsg: 'params error: symbol invalid',
          result: {},
        });
      }
      if (url.pathname === '/v5/market/tickers') {
        return Response.json({
          retCode: 0,
          result: { category: 'linear', list: [{ symbol, openInterest: '52345.123' }] },
          time: NOW,
        });
      }
      const step = url.searchParams.get('intervalTime') as string;
      const all = (points[step] ?? []).toReversed();
      const from = Number(url.searchParams.get('cursor') || 0);
      const page = all.slice(from, from + 200);
      return Response.json({
        retCode: 0,
        result: {
          list: page.map((p) => ({ openInterest: String(p.value), timestamp: String(p.time) })),
          nextPageCursor: from + 200 < all.length ? String(from + 200) : '',
        },
      });
    }) as typeof fetch;
  }

  const every = (step: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const time = Math.floor(NOW / step) * step - (count - 1 - i) * step;
      return { time, value: valueAt(time) };
    });

  it('reads the open interest now, and calls a symbol it doesn’t list unknown', async () => {
    const source = new BybitOiSource({ fetch: bybitFetch({}, []), paceMs: 0, now: () => NOW });
    expect(await source.current(contract('BYBIT', 'BTCUSDT.P_OI'))).toEqual({
      time: NOW,
      value: 52_345.123,
    });
    await expect(source.check(contract('BYBIT', 'ETHUSDT.P_OI'))).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
  });

  it('keeps a month of hours, then every day it has', async () => {
    const calls: string[] = [];
    const hours = every(HOUR, 1_000);
    const days = every(DAY, 900);
    const source = new BybitOiSource({
      fetch: bybitFetch({ '1h': hours, '1d': days }, calls),
      paceMs: 0,
      now: () => NOW,
    });
    const record = recorder();
    await source.backfill(contract('BYBIT', 'BTCUSDT.P_OI'), record.into);
    const kept = record.points.filter((p) => p.time >= NOW - 30 * DAY).length;
    expect(kept).toBeGreaterThan(30 * 24 - 2);
    expect(record.points.some((p) => p.time === (days[0] as OiPoint).time)).toBe(true);
    expect(record.reached).toEqual([NOW - 30 * DAY]);
    // The hours stop paging once they're past the month.
    expect(calls.filter((call) => call.endsWith('?1h')).length).toBe(4);
  });
});

describe('OKX: its trading statistics, paged back by time', () => {
  function okxFetch(points: Record<string, OiPoint[]>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const instId = url.searchParams.get('instId');
      if (instId !== 'BTC-USDT-SWAP') {
        return Response.json({ code: '51001', msg: "Instrument ID doesn't exist.", data: [] });
      }
      if (url.pathname === '/api/v5/public/open-interest') {
        return Response.json({
          code: '0',
          msg: '',
          data: [
            {
              instId,
              instType: 'SWAP',
              oi: '3450072.83',
              oiCcy: '34500.7283',
              oiUsd: '2.6e9',
              ts: String(NOW),
            },
          ],
        });
      }
      const period = url.searchParams.get('period') as string;
      const end = Number(url.searchParams.get('end') ?? Number.POSITIVE_INFINITY);
      const rows = (points[period] ?? [])
        .filter((p) => p.time < end)
        .toReversed()
        .slice(0, 100)
        .map((p) => [String(p.time), String(p.value), '1', '1']);
      return Response.json({ code: '0', msg: '', data: rows });
    }) as typeof fetch;
  }

  it('reads the open interest now, in contracts, and calls an unknown instrument unknown', async () => {
    const source = new OkxOiSource({ fetch: okxFetch({}), paceMs: 0 });
    expect(await source.current(contract('OKX', 'BTCUSDT.P_OI'))).toEqual({
      time: NOW,
      value: 3_450_072.83,
    });
    await expect(source.check(contract('OKX', 'ETHUSDT.P_OI'))).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
  });

  it('keeps every hour and day it has, as far back as they go', async () => {
    const hours = Array.from({ length: 1_440 }, (_, i) => ({
      time: NOW - (1_440 - i) * HOUR,
      value: i + 1,
    }));
    const days = Array.from({ length: 1_000 }, (_, i) => ({
      time: NOW - (1_000 - i) * DAY,
      value: i + 1,
    }));
    const source = new OkxOiSource({ fetch: okxFetch({ '1H': hours, '1D': days }), paceMs: 0 });
    const record = recorder();
    await source.backfill(contract('OKX', 'BTCUSDT.P_OI'), record.into);
    expect(record.points).toHaveLength(2_440);
    expect(record.reached).toEqual([(hours[0] as OiPoint).time]);
  });
});

// ---- the adapter ----

/** A source playing an exchange: hourly points before its 30 days of 5-minute ones. */
class ScriptedSource implements OiSource {
  readonly exchange = 'BINANCE' as const;
  readonly recentWindowMs = 30 * DAY;
  older = Array.from({ length: 24 * 60 }, (_, i) => {
    const time = Math.floor((NOW - 30 * DAY) / HOUR) * HOUR - (24 * 60 - i) * HOUR;
    return { time, value: valueAt(time) };
  });
  latest = Array.from({ length: 30 * 288 }, (_, i) => {
    const time = Math.floor((NOW - 30 * DAY) / STEP_MS) * STEP_MS + i * STEP_MS;
    return { time, value: valueAt(time) };
  }).filter((p) => p.time < NOW);
  checkError: Error | null = null;
  failing = false;
  polls: (number | Error)[] = [];
  gate: Promise<void> = Promise.resolve();
  recentCalls = 0;

  async check() {
    if (this.checkError) throw this.checkError;
  }

  async current(): Promise<OiPoint> {
    const next = this.polls.shift() ?? 1;
    if (next instanceof Error) throw next;
    return { time: NOW, value: next };
  }

  async recent(_: OiContract, sinceMs: number): Promise<OiPoint[]> {
    this.recentCalls++;
    if (this.failing) throw new MarketError('upstream_error', 'Binance is unreachable');
    return this.latest.filter((p) => p.time >= sinceMs);
  }

  async backfill(_: OiContract, into: Backfill): Promise<void> {
    await this.gate;
    if (this.failing) throw new MarketError('upstream_error', 'Binance is unreachable');
    into.put(this.older);
  }
}

function adapterOf(
  source: OiSource,
  dir: string,
  extra: { pollMs?: number; recordMs?: number } = {},
) {
  return new OpenInterestExchange({
    exchange: 'BINANCE',
    name: 'Binance',
    source,
    dataDir: dir,
    now: () => NOW,
    pollMs: extra.pollMs ?? 60_000,
    recordMs: extra.recordMs ?? 60_000,
  });
}

describe('OpenInterestExchange: _OI symbols as an exchange to the market service', () => {
  it('describes one as TradingView does: no volume, no book, its values written in thousands', async () => {
    const adapter = adapterOf(new ScriptedSource(), await dataDir());
    const info = await adapter.resolveSymbol('BTCUSDTPERP_OI');
    expect(info).toMatchObject({
      id: 'BINANCE:BTCUSDT.P_OI',
      ticker: 'BTCUSDT.P_OI',
      base: 'BTC',
      quote: 'BTC',
      description: 'BTCUSDT Open Interest',
      type: 'index',
      format: 'volume',
      hasBook: false,
      pricePrecision: 3,
    });
    await expect(adapter.resolveSymbol('BTCUSDT_OI')).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
    await adapter.close();
  });

  it('serves recent bars at once, and older ones once their download has reached them', async () => {
    const source = new ScriptedSource();
    let open = () => {};
    source.gate = new Promise((resolve) => {
      open = resolve;
    });
    const adapter = adapterOf(source, await dataDir());
    const daily = adapter.fetchBars('BTCUSDT.P_OI', r('1D'), null, 5_000);
    let served = false;
    void daily.then(() => {
      served = true;
    });
    const recent = await adapter.fetchBars('BTCUSDT.P_OI', r('5'), null, 100);
    expect(recent).toHaveLength(100);
    expect(recent.at(-1)?.time).toBe((NOW - STEP_MS) / 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(served).toBe(false);
    open();
    const bars = await daily;
    // 60 days of hours, then 30 of 5 minutes: every day's bar, each close the next one's open.
    expect(bars.length).toBeGreaterThanOrEqual(90);
    expect(bars.slice(1).every((bar, i) => bar.open === (bars[i] as { close: number }).close)).toBe(
      true,
    );
    const day = bars.find((bar) => bar.time === Date.UTC(2026, 9, 1) / 1000);
    expect(day).toMatchObject({
      open: valueAt(Date.UTC(2026, 9, 1)),
      close: valueAt(Date.UTC(2026, 9, 2)),
      volume: 1,
    });
    await adapter.close();
  });

  it('keeps what it downloaded, and shows it when the exchange can’t be reached', async () => {
    const dir = await dataDir();
    const first = adapterOf(new ScriptedSource(), dir);
    await first.fetchBars('BTCUSDT.P_OI', r('1D'), null, 10);
    await first.idle();
    await first.close();
    expect((await readdir(join(dir, 'oi', 'binance', 'BTCUSDT'))).length).toBeGreaterThan(1);
    const offline = new ScriptedSource();
    offline.checkError = new MarketError('upstream_error', 'Binance is unreachable');
    offline.failing = true;
    const second = adapterOf(offline, dir);
    const bars = await second.fetchBars('BTCUSDT.P_OI', r('1D'), null, 10);
    expect(bars).toHaveLength(10);
    expect(bars.at(-1)?.close).toBe(valueAt(NOW - STEP_MS));
    await second.close();
    // A perpetual the exchange says doesn't exist isn't shown from what's kept.
    const gone = new ScriptedSource();
    gone.checkError = new MarketError('unknown_symbol', 'Binance has no such perpetual');
    await expect(adapterOf(gone, dir).resolveSymbol('BTCUSDT.P_OI')).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
  });

  it('moves the forming bar with each poll, and says when the polls fail', async () => {
    const source = new ScriptedSource();
    source.polls = [95_000, new Error('a'), new Error('b'), new Error('c'), 96_000];
    const adapter = adapterOf(source, await dataDir(), { pollMs: 2 });
    await adapter.resolveSymbol('BTCUSDT.P_OI');
    const updates: CandleUpdate[] = [];
    const states: FeedState[] = [];
    adapter.onFeedState((state) => states.push(state));
    const stop = adapter.subscribeCandles('BTCUSDT.P_OI', r('1D'), (update) =>
      updates.push(update),
    );
    await vi.waitFor(() => expect(states).toEqual(['down', 'up']));
    stop();
    const today = Date.UTC(2026, 10, 7);
    expect(updates[0]?.bar).toMatchObject({
      time: today / 1000,
      open: valueAt(today),
      close: 95_000,
    });
    expect(updates.at(-1)?.bar.close).toBe(95_000); // a second poll at the same time adds nothing
    await adapter.close();
  });

  it('records the exchange’s own recent points while one is watched', async () => {
    const source = new ScriptedSource();
    const adapter = adapterOf(source, await dataDir(), { recordMs: 5 });
    await adapter.resolveSymbol('BTCUSDT.P_OI');
    await adapter.idle();
    const before = source.recentCalls;
    const stop = adapter.subscribeCandles('BTCUSDT.P_OI', r('5'), () => {});
    await vi.waitFor(() => expect(source.recentCalls).toBeGreaterThan(before + 1));
    stop();
    await adapter.close();
  });
});

describe('The market service sends _OI symbols to the open interest adapters', () => {
  it('on their exchange only, the rest going where they went', async () => {
    const spot = new FakeExchange();
    spot.bars = dailyBars(10, Date.UTC(2026, 9, 18) / 1000);
    const openInterest = adapterOf(new ScriptedSource(), await dataDir());
    const market = new MarketService([spot], { openInterest: [openInterest] });
    const weeks = await market.getBars('BINANCE:BTCUSDT.P_OI', '1W', null, 4);
    expect(weeks.bars).toHaveLength(4);
    expect(weeks.bars.at(-1)?.close).toBe(valueAt(NOW - STEP_MS));
    expect((await market.resolveSymbol('BINANCE:BTCPERP_OI')).id).toBe('BINANCE:BTCUSD.P_OI');
    expect((await market.getBars('FAKE:XRPUSDT', '1D', null, 3)).bars).toHaveLength(3);
    await expect(market.getBars('BINANCE:XRPUSDT', '1D', null, 3)).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
    await expect(market.getBars('BINANCE:BTCUSDT.P_OI', '1', null, 3)).rejects.toMatchObject({
      code: 'unsupported_resolution',
    });
    await market.close();
  });
});

// Keeps the helpers' file reads honest: a month file is one line of JSON.
describe('data/oi/ files', () => {
  it('are compact JSON, one value or null per 5-minute step', async () => {
    const dir = await dataDir();
    const series = new OiSeries(dir);
    series.put([{ time: Date.UTC(2026, 1, 1), value: 7 }]);
    await series.save();
    const text = await readFile(join(dir, '2026-02.json'), 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    const file = JSON.parse(text);
    expect(file).toMatchObject({ v: 1, month: '2026-02', step: STEP_MS });
    expect(file.values).toHaveLength(28 * 288);
    expect(file.values[0]).toBe(7);
  });
});
