import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSTRUMENTS_TTL_MS,
  type Instrument,
  InstrumentBook,
  RequestPacer,
} from '../src/exchanges/shared.ts';

const instrument = (ticker: string): Instrument => ({
  ticker,
  restId: ticker,
  streamId: ticker,
  base: ticker.slice(0, 3),
  quote: ticker.slice(3),
  tickSize: 0.0001,
});

describe('InstrumentBook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the pair list once, ahead of the first lookup when prepared', async () => {
    const load = vi.fn(async () => [instrument('XRPUSDT')]);
    const book = new InstrumentBook('Test', load);
    await book.prepare();
    expect(book.loaded('XRPUSDT')).toEqual(instrument('XRPUSDT'));
    expect(await book.get('XRPUSDT')).toEqual(instrument('XRPUSDT'));
    expect(load).toHaveBeenCalledTimes(1);
    await expect(book.get('NOPEUSDT')).rejects.toMatchObject({ code: 'unknown_symbol' });
  });

  it('answers from an aging list while it fetches a new one, so a lookup never waits on it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let release: (list: Instrument[]) => void = () => {};
    const load = vi
      .fn<() => Promise<Instrument[]>>()
      .mockResolvedValueOnce([instrument('XRPUSDT')])
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const book = new InstrumentBook('Test', load);
    await book.prepare();

    vi.setSystemTime(Date.now() + INSTRUMENTS_TTL_MS + 1);
    expect(await book.get('XRPUSDT')).toEqual(instrument('XRPUSDT')); // at once, from the old list
    expect(load).toHaveBeenCalledTimes(2);
    release([instrument('XRPUSDT'), instrument('LDOUSDT')]);
    await vi.waitFor(() => expect(book.loaded('LDOUSDT')).toBeDefined());
    expect(await book.get('LDOUSDT')).toEqual(instrument('LDOUSDT'));
  });

  it('tries again after a failed load', async () => {
    const load = vi
      .fn<() => Promise<Instrument[]>>()
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValueOnce([instrument('XRPUSDT')]);
    const book = new InstrumentBook('Test', load);
    await book.prepare(); // a failure here is quiet
    expect(await book.get('XRPUSDT')).toEqual(instrument('XRPUSDT'));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('RequestPacer', () => {
  it('spaces requests at least the given gap apart, in order', async () => {
    const pacer = new RequestPacer(40);
    const started: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await pacer.wait();
        started.push(Date.now());
      }),
    );
    expect(started).toHaveLength(3);
    for (let i = 1; i < started.length; i++) {
      expect((started[i] ?? 0) - (started[i - 1] ?? 0)).toBeGreaterThanOrEqual(35);
    }
  });
});
