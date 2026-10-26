import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveCoinWatchClient } from '../src/cryptocap/livecoinwatch.ts';
import {
  BLEND_DAYS,
  blendFactor,
  dayBars,
  ETHEREUM_START_MS,
  OlderCaps,
  type OlderSeries,
} from '../src/cryptocap/older.ts';
import { SecretStore } from '../src/storage/secrets.ts';
import { type FakeLiveCoinWatchOptions, fakeLiveCoinWatch } from './helpers/FakeLiveCoinWatch.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const KEY = 'lcw-test-key-0000';
/** Our history's first day in these tests. */
const JOIN = Date.UTC(2025, 9, 26);

/** Live Coin Watch's market every hour: TOTAL rising 1B an hour from 2T, Bitcoin 60% of it. */
const capAt = (ms: number) => 2e12 + ((ms - JOIN) / HOUR) * 1e9;
const ethAt = (ms: number) => 3e11 + ((ms - JOIN) / HOUR) * 1e8;

interface Setup {
  key?: boolean;
  /** Our first day, and where downloads start (JOIN and 20 days before by default). */
  join?: number;
  origin?: number;
  dataDir?: string;
  status?: FakeLiveCoinWatchOptions['status'];
  credits?: FakeLiveCoinWatchOptions['credits'];
  skip?: FakeLiveCoinWatchOptions['skip'];
  ours?: (series: OlderSeries, joinMs: number) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
}

async function setup({
  key = true,
  join: joinMs = JOIN,
  origin = joinMs - 20 * DAY,
  dataDir = mkdtempSync(join(tmpdir(), 'tn-older-')),
  status,
  credits,
  skip,
  ours = async () => null,
  sleep,
}: Setup = {}) {
  const secrets = new SecretStore(dataDir, {});
  if (key) await secrets.saveLiveCoinWatch(KEY);
  const fake = fakeLiveCoinWatch({
    cap: capAt,
    ethereum: ethAt,
    ...(status ? { status } : {}),
    ...(credits ? { credits } : {}),
    ...(skip ? { skip } : {}),
  });
  const waits: number[] = [];
  const older = new OlderCaps({
    secrets,
    dataDir,
    joinMs: () => joinMs,
    ours,
    client: new LiveCoinWatchClient({ url: 'http://lcw.test', fetch: fake.fetch }),
    originMs: origin,
    gapMs: 0,
    sleep: async (ms) => {
      waits.push(ms);
      await sleep?.(ms);
    },
    now: () => JOIN + 365 * DAY,
  });
  const windows = () => fake.requests.filter((request) => request.path === '/overview/history');
  return { older, fake, windows, secrets, dataDir, waits };
}

const savedIn = (dataDir: string) =>
  JSON.parse(readFileSync(join(dataDir, 'cryptocap', 'older.json'), 'utf8'));

describe("a day's bars from Live Coin Watch's points", () => {
  const points = (from: number, to: number) => {
    const out = [];
    for (let date = from; date <= to; date += HOUR) {
      out.push({ date, cap: capAt(date), btcDominance: 0.6 });
    }
    return out;
  };

  it('opens at midnight, closes at the next, and takes the extremes between', () => {
    const market = points(JOIN, JOIN + DAY);
    const eth = market.map(({ date }) => ({ date, cap: ethAt(date) }));
    const days = dayBars(market, eth, JOIN, JOIN + DAY);
    expect(days.TOTAL[0]).toEqual([JOIN / 1000, 2e12, 2.024e12, 2e12, 2.024e12]);
    // TOTAL2 is TOTAL without Bitcoin's 60%, TOTAL3 without Ethereum too, BTC.D the 60.
    expect(days.TOTAL2[0]?.[4]).toBeCloseTo(2.024e12 * 0.4, -3);
    expect(days.TOTAL3[0]?.[4]).toBeCloseTo(2.024e12 * 0.4 - ethAt(JOIN + DAY), -3);
    expect(days['BTC.D'][0]?.slice(1)).toEqual([60, 60, 60, 60]);
  });

  it('leaves Ethereum out before it existed, and a day without points near its edges', () => {
    const before = Date.UTC(2015, 0, 10);
    expect(before).toBeLessThan(ETHEREUM_START_MS);
    const days = dayBars(points(before, before + DAY), [], before, before + DAY);
    expect(days.TOTAL3[0]?.[4]).toBe(days.TOTAL2[0]?.[4]);
    // Points only from 06:00: the day's open isn't known.
    expect(dayBars(points(JOIN + 6 * HOUR, JOIN + DAY), [], JOIN, JOIN + DAY).TOTAL).toEqual([]);
  });
});

describe('blending toward our history', () => {
  it('moves all the way at the join, none 30 days before, in a straight line', () => {
    expect(blendFactor(JOIN - DAY, JOIN, 0.03)).toBeCloseTo(1 + 0.03 * (29 / 30), 12);
    expect(blendFactor(JOIN - 15 * DAY, JOIN, 0.03)).toBeCloseTo(1.015, 12);
    expect(blendFactor(JOIN - BLEND_DAYS * DAY, JOIN, 0.03)).toBe(1);
    expect(blendFactor(JOIN - 400 * DAY, JOIN, 0.03)).toBe(1);
  });
});

describe('OlderCaps', () => {
  it('downloads back from the join, a day a bar, and says how far it got', async () => {
    const { older, windows, fake } = await setup();
    expect((await older.status()).state).toBe('none');
    await older.start();
    await older.idle();
    expect(await older.status()).toEqual({
      key: { masked: '••••0000', source: 'file' },
      state: 'done',
      progress: 1,
      from: '2025-10-06',
      until: '2025-10-29',
      message: null,
    });
    // Back from the join: the first window ends 4 days past it, the last starts at the origin.
    expect(windows()[0]?.body).toMatchObject({ currency: 'USD', start: JOIN, end: JOIN + 4 * DAY });
    expect(windows().at(-1)?.body).toMatchObject({ start: JOIN - 20 * DAY });
    expect(windows()).toHaveLength(6);
    expect(fake.requests.every((request) => request.key === KEY)).toBe(true);
  });

  it('serves the days before the join, moved toward ours over the last 30', async () => {
    const ours = 2.2e12; // ours on the join day; Live Coin Watch's close there is 2.024T
    const { older } = await setup({ ours: async (series) => (series === 'TOTAL' ? ours : null) });
    await older.start();
    await older.idle();
    const bars = await older.bars('TOTAL', JOIN - 30 * DAY, JOIN + 30 * DAY);
    expect(bars.map((bar) => bar.time)).toEqual(
      Array.from({ length: 20 }, (_, i) => (JOIN - (20 - i) * DAY) / 1000),
    );
    // Each counts as traded, so weeks and months are made of every day (resampleBars).
    expect(bars.every((bar) => bar.volume > 0)).toBe(true);
    const ratio = ours / 2.024e12 - 1;
    expect(bars.at(-1)?.close).toBeCloseTo(capAt(JOIN) * (1 + ratio * (29 / 30)), -3);
    expect(bars[0]?.close).toBeCloseTo(capAt(JOIN - 19 * DAY) * (1 + ratio * (10 / 30)), -3);
    // Without ours to blend toward, Live Coin Watch's own values.
    const raw = await older.bars('TOTAL2', JOIN - DAY, JOIN);
    expect(raw).toHaveLength(1);
    expect(raw[0]?.close).toBeCloseTo(capAt(JOIN) * 0.4, -3);
  });

  it('fills a day Live Coin Watch has no points for with the close before it', async () => {
    const gap = JOIN - 10 * DAY;
    const { older } = await setup({
      skip: (ms) => ms > gap - 3 * HOUR && ms < gap + DAY + 3 * HOUR,
    });
    await older.start();
    await older.idle();
    const bars = await older.bars('TOTAL', gap - DAY, gap + 2 * DAY);
    expect(bars.map((bar) => bar.time)).toEqual([gap - DAY, gap, gap + DAY].map((ms) => ms / 1000));
    const before = capAt(gap - 3 * HOUR);
    expect(bars[0]?.close).toBe(before);
    expect(bars[1]).toMatchObject({ open: before, high: before, low: before, close: before });
    expect(bars[2]?.open).toBe(capAt(gap + DAY + 3 * HOUR));
  });

  it('carries on where it stopped, and never fetches a window twice', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tn-older-'));
    const first = await setup({ dataDir });
    await first.older.start();
    expect(first.windows()).toHaveLength(1);
    // Stopped while its first window comes in: that window is kept.
    await first.older.close();
    await first.older.idle();
    expect(savedIn(dataDir).covered).toEqual([JOIN, JOIN + 4 * DAY]);

    const again = await setup({ dataDir });
    await again.older.start();
    await again.older.idle();
    expect((await again.older.status()).state).toBe('done');
    const before = first.windows().map((request) => request.body.start);
    const after = again.windows().map((request) => request.body.start);
    expect(before.length + after.length).toBe(6);
    expect(after.some((start) => before.includes(start))).toBe(false);

    // Done: a restart fetches nothing.
    const done = await setup({ dataDir });
    await done.older.start();
    await done.older.idle();
    expect(done.fake.requests).toEqual([]);
  });

  it('keeps what came in when the gateway stops halfway through a window', async () => {
    let breaths = 0;
    const { older, dataDir } = await setup({
      // The third breath, after the second window's market, never ends: a request under way.
      sleep: () => (++breaths === 3 ? new Promise(() => {}) : Promise.resolve()),
    });
    await older.start();
    await vi.waitFor(() => expect(breaths).toBe(3));
    await older.close();
    expect(savedIn(dataDir).covered).toEqual([JOIN, JOIN + 4 * DAY]);
    expect(savedIn(dataDir).days.TOTAL).toHaveLength(4);
  });

  it('asks for Ethereum only once it existed, with a pause after each request', async () => {
    const join = ETHEREUM_START_MS + 2 * DAY;
    const { older, fake, waits } = await setup({ join, origin: join - 8 * DAY });
    await older.start();
    await older.idle();
    // Three windows back from 4 days past the join; the oldest ends before Ethereum's first day.
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/overview/history',
      '/coins/single/history',
      '/overview/history',
      '/coins/single/history',
      '/overview/history',
    ]);
    expect(waits).toHaveLength(5);
    // Before it, TOTAL3 is TOTAL2.
    const total2 = await older.bars('TOTAL2', join - 8 * DAY, join - 4 * DAY);
    const total3 = await older.bars('TOTAL3', join - 8 * DAY, join - 4 * DAY);
    expect(total3.map((bar) => bar.close)).toEqual(total2.map((bar) => bar.close));
  });

  it('downloads once when started twice at the same moment', async () => {
    // Each breath lets the disk answer, so the second start's key comes in mid-download.
    const { older, windows } = await setup({
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await Promise.all([older.start(), older.start()]);
    await older.idle();
    expect(windows()).toHaveLength(6);
  });

  it("slows down when asked, waits for the day's requests to renew, and stops at a key Live Coin Watch rejects", async () => {
    // Asked too fast: 30 s, then on.
    let refuse = true;
    const limited = await setup({
      status: (path) => {
        if (path !== '/overview/history' || !refuse) return null;
        refuse = false;
        return 429;
      },
    });
    await limited.older.start();
    await limited.older.idle();
    expect((await limited.older.status()).state).toBe('done');
    expect(limited.waits).toContain(30_000);
    expect(limited.waits).not.toContain(DAY + 5 * 60_000);

    // The day's requests used up: until 5 minutes past UTC midnight.
    let left = 0;
    const usedUp = await setup({
      status: (path) => (path === '/overview/history' && left === 0 ? 429 : null),
      credits: () => left,
      sleep: async (ms) => {
        if (ms > 60_000) left = 10_000; // midnight
      },
    });
    await usedUp.older.start();
    await usedUp.older.idle();
    expect((await usedUp.older.status()).state).toBe('done');
    expect(usedUp.waits).toContain(DAY + 5 * 60_000);
    expect(usedUp.waits).not.toContain(30_000);

    const rejected = await setup({ status: (path) => (path === '/overview/history' ? 401 : null) });
    await rejected.older.start();
    await rejected.older.idle();
    expect(await rejected.older.status()).toMatchObject({
      state: 'error',
      message: 'Live Coin Watch rejected the key',
    });
  });

  it('checks a key before keeping it, downloads with it, and keeps what came in without it', async () => {
    const { older, secrets, fake } = await setup({ key: false });
    await older.start();
    expect(fake.requests).toEqual([]);
    const saved = await older.saveKey('  lcw-new-key-9999 ');
    expect(saved.key).toEqual({ masked: '••••9999', source: 'file' });
    expect((await secrets.livecoinwatch())?.key).toBe('lcw-new-key-9999');
    await older.idle();
    expect(fake.requests.every((request) => request.key === 'lcw-new-key-9999')).toBe(true);
    const removed = await older.removeKey();
    expect(removed).toMatchObject({ key: null, state: 'done', from: '2025-10-06' });

    const bad = await setup({ key: false, status: (path) => (path === '/credits' ? 401 : null) });
    await expect(bad.older.saveKey('nope')).rejects.toMatchObject({
      code: 'bad_request',
      message: 'Live Coin Watch rejected this key',
    });
    expect(await bad.secrets.livecoinwatch()).toBeNull();
    await expect(bad.older.saveKey('   ')).rejects.toMatchObject({ code: 'bad_request' });
  });
});
