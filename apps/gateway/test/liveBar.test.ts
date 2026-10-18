import { type Bar, parseResolution, type Resolution } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { LiveBarAggregator } from '../src/market/liveBar.ts';

function mustParse(text: string): Resolution {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(`bad resolution ${text}`);
  return resolution;
}

const minute = mustParse('1');
const at = (hhmmss: string) => Date.parse(`2026-10-18T${hhmmss}Z`);
const sec = (hhmmss: string) => at(hhmmss) / 1000;
const bar12: Bar = {
  time: sec('12:00:00'),
  open: 1.3,
  high: 1.31,
  low: 1.29,
  close: 1.3,
  volume: 100,
};

function seeded() {
  const agg = new LiveBarAggregator(minute);
  agg.seed(bar12);
  return agg;
}

describe('LiveBarAggregator', () => {
  it('ignores trades until it has a bar to build on', () => {
    const agg = new LiveBarAggregator(minute);
    expect(agg.applyTrade({ price: 1.3, quantity: 1, time: at('12:00:01') })).toEqual([]);
    expect(agg.current()).toBeNull();
  });

  it('starts from a seed', () => {
    const agg = new LiveBarAggregator(minute);
    expect(agg.seed(bar12)).toEqual([{ bar: bar12, historical: false }]);
    expect(agg.current()).toEqual(bar12);
  });

  it('ticks the close, high, low and volume on every trade', () => {
    const agg = seeded();
    agg.applyTrade({ price: 1.32, quantity: 5, time: at('12:00:10') });
    const [change] = agg.applyTrade({ price: 1.28, quantity: 2, time: at('12:00:11') });
    expect(change).toEqual({
      bar: { ...bar12, high: 1.32, low: 1.28, close: 1.28, volume: 107 },
      historical: false,
    });
  });

  it('keeps trades newer than a candle snapshot on top of it', () => {
    const agg = seeded();
    agg.applyTrade({ price: 1.35, quantity: 3, time: at('12:00:30') });
    // A snapshot taken at :20 doesn't know about the :30 trade yet.
    const [change] = agg.applyCandle({
      bar: { ...bar12, high: 1.33, low: 1.29, close: 1.31, volume: 150 },
      eventTime: at('12:00:20'),
    });
    expect(change?.bar).toEqual({ ...bar12, high: 1.35, low: 1.29, close: 1.35, volume: 153 });
  });

  it('lets a snapshot taken after the trades win', () => {
    const agg = seeded();
    agg.applyTrade({ price: 1.35, quantity: 3, time: at('12:00:30') });
    const snapshot = { ...bar12, high: 1.35, low: 1.29, close: 1.34, volume: 160 };
    const [change] = agg.applyCandle({ bar: snapshot, eventTime: at('12:00:40') });
    expect(change?.bar).toEqual(snapshot);
  });

  it('opens the next bar on the first trade past the boundary', () => {
    const agg = seeded();
    const [change] = agg.applyTrade({ price: 1.4, quantity: 7, time: at('12:01:00') });
    expect(change).toEqual({
      bar: { time: sec('12:01:00'), open: 1.4, high: 1.4, low: 1.4, close: 1.4, volume: 7 },
      historical: false,
    });
  });

  it('ignores late trades for an earlier bar', () => {
    const agg = seeded();
    agg.applyTrade({ price: 1.4, quantity: 7, time: at('12:01:00') });
    expect(agg.applyTrade({ price: 9, quantity: 1, time: at('12:00:59') })).toEqual([]);
    expect(agg.current()?.close).toBe(1.4);
  });

  it("reports the previous bar's final snapshot as a historical correction", () => {
    const agg = seeded();
    agg.applyTrade({ price: 1.4, quantity: 7, time: at('12:01:00') });
    const final = { ...bar12, close: 1.39, high: 1.395, volume: 400 };
    expect(agg.applyCandle({ bar: final, eventTime: at('12:01:00') })).toEqual([
      { bar: final, historical: true },
    ]);
    expect(agg.current()?.time).toBe(sec('12:01:00'));
  });

  it('follows the exchange when its snapshot is for a newer bar', () => {
    const agg = seeded();
    const next = { ...bar12, time: sec('12:01:00'), open: 1.31 };
    expect(agg.applyCandle({ bar: next, eventTime: at('12:01:02') })).toEqual([
      { bar: next, historical: false },
    ]);
  });

  it('ignores a seed older than what the stream already delivered', () => {
    const agg = seeded();
    agg.applyTrade({ price: 1.4, quantity: 7, time: at('12:01:00') });
    expect(agg.seed(bar12)).toEqual([]);
    expect(agg.current()?.time).toBe(sec('12:01:00'));
  });

  it('forgets everything on reset', () => {
    const agg = seeded();
    agg.reset();
    expect(agg.current()).toBeNull();
    expect(agg.applyTrade({ price: 1.3, quantity: 1, time: at('12:00:05') })).toEqual([]);
  });

  it('returns copies, so callers cannot corrupt its state', () => {
    const agg = seeded();
    const [change] = agg.applyTrade({ price: 1.3, quantity: 1, time: at('12:00:05') });
    if (change) change.bar.close = 999;
    expect(agg.current()?.close).toBe(1.3);
  });
});
