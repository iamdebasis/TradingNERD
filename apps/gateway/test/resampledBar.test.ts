import { type Bar, parseResolution, type Resolution } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { ResampledBarAggregator } from '../src/market/resampledBar.ts';

const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(`bad resolution ${text}`);
  return resolution;
};

/** 10:00 UTC, where a 3-minute bar opens. */
const T0 = Date.UTC(2026, 9, 18, 10, 0) / 1000;

/** The 1-minute bar opening `minute` minutes after 10:00. */
const minute = (
  offset: number,
  [open, high, low, close]: [number, number, number, number],
  volume = 1,
): Bar => ({ time: T0 + offset * 60, open, high, low, close, volume });

const ms = (offsetSeconds: number) => (T0 + offsetSeconds) * 1000;

/** 3-minute bars built from 1-minute bars. */
const threeMinutes = () => new ResampledBarAggregator(r('3'), r('1'));

describe('ResampledBarAggregator', () => {
  it('says nothing until seeded, then folds the period so far', () => {
    const live = threeMinutes();
    // The stream can speak before the REST seed lands; that alone would be half a bar.
    expect(live.applyCandle({ bar: minute(1, [2, 2.5, 1.5, 2.2]), eventTime: ms(70) })).toEqual([]);
    expect(live.current()).toBeNull();

    const changes = live.seed([
      minute(-1, [0.5, 0.9, 0.4, 0.8]), // 09:59 belongs to the previous bar
      minute(0, [1, 1.4, 0.9, 1.2]),
      minute(1, [2, 2.3, 1.8, 2.1]), // older than the stream's copy of 10:01
    ]);
    expect(changes).toEqual([
      { bar: { time: T0, open: 1, high: 2.5, low: 0.9, close: 2.2, volume: 2 }, historical: false },
    ]);
  });

  it('updates the bar as candles and trades arrive within its period', () => {
    const live = threeMinutes();
    live.seed([minute(0, [1, 1.4, 0.9, 1.2]), minute(1, [1.2, 1.3, 1.1, 1.25])]);

    // A trade opens 10:02, still inside the 10:00 bar.
    const [change] = live.applyTrade({ price: 1.6, quantity: 2, time: ms(150) });
    expect(change).toEqual({
      bar: { time: T0, open: 1, high: 1.6, low: 0.9, close: 1.6, volume: 4 },
      historical: false,
    });
  });

  it('opens the next bar on the first trade past its period', () => {
    const live = threeMinutes();
    live.seed([minute(0, [1, 1.4, 0.9, 1.2]), minute(2, [1.2, 1.3, 1.1, 1.25])]);
    const [change] = live.applyTrade({ price: 1.7, quantity: 1, time: ms(180.5) });
    expect(change).toEqual({
      bar: { time: T0 + 180, open: 1.7, high: 1.7, low: 1.7, close: 1.7, volume: 1 },
      historical: false,
    });
  });

  it("corrects the previous bar when its last candle's final version arrives late", () => {
    const live = threeMinutes();
    live.seed([minute(0, [1, 1.4, 0.9, 1.2]), minute(2, [1.2, 1.3, 1.1, 1.25])]);
    live.applyTrade({ price: 1.7, quantity: 1, time: ms(181) });

    // Binance's final 10:02 candle: a higher high than the trades showed.
    const changes = live.applyCandle({
      bar: minute(2, [1.2, 1.9, 1.1, 1.3], 5),
      eventTime: ms(182),
    });
    expect(changes).toEqual([
      { bar: { time: T0, open: 1, high: 1.9, low: 0.9, close: 1.3, volume: 6 }, historical: true },
    ]);
    // The current bar is untouched.
    expect(live.current()?.time).toBe(T0 + 180);
  });

  it('leaves out base candles without trades, as the exchange does', () => {
    const live = threeMinutes();
    const [change] = live.seed([
      minute(0, [0.8, 0.8, 0.8, 0.8], 0), // a placeholder at the previous close
      minute(1, [1, 1.1, 0.95, 1.05]),
    ]);
    expect(change?.bar).toEqual({
      time: T0,
      open: 1,
      high: 1.1,
      low: 0.95,
      close: 1.05,
      volume: 1,
    });
  });

  it('starts over after a reset and waits for a new seed', () => {
    const live = threeMinutes();
    live.seed([minute(0, [1, 1.4, 0.9, 1.2])]);
    live.reset();
    expect(live.current()).toBeNull();
    expect(live.applyCandle({ bar: minute(1, [1, 1, 1, 1]), eventTime: ms(61) })).toEqual([]);
    expect(live.seed([minute(0, [1, 1.4, 0.9, 1.2])])).toHaveLength(1);
  });
});
