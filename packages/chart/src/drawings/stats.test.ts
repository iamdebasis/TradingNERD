import { defaultDrawingStyle } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { formatPrice } from '../format';
import { type StatsInput, statsRows } from './stats';

const infoLine = defaultDrawingStyle('info-line').stats;
const none = defaultDrawingStyle('trend-line').stats;

const input = (overrides: Partial<StatsInput> = {}): StatsInput => ({
  from: { price: 1_225, time: 0 },
  to: { price: 1_237.5, time: 163_800 },
  a: { x: 100, y: 300 },
  b: { x: 412, y: 300 },
  bars: 40,
  stats: infoLine,
  formatPrice: (value) => formatPrice(value, 1),
  tickSize: 0.01,
  ...overrides,
});

describe('statsRows', () => {
  it('writes an Info line’s price, bars and time, distance and angle as TradingView does', () => {
    expect(statsRows(input())).toEqual([
      { icon: 'price', text: '12.5 (1.02%), 1250' },
      { icon: 'bars', text: '40 bars (1d 21h 30m), distance: 312 px' },
      { icon: 'angle', text: '0º' },
    ]);
  });

  it('writes a fall with a true minus', () => {
    const [price] = statsRows(input({ to: { price: 1_212.5, time: 163_800 } }));
    expect(price?.text).toBe('−12.5 (−1.02%), −1250');
  });

  it('leaves out the stats that are off, and the brackets with the change', () => {
    const stats = { ...none, percentChange: true, dateTimeRange: true, angle: true };
    expect(statsRows(input({ stats, b: { x: 200, y: 200 } }))).toEqual([
      { icon: 'price', text: '1.02%' },
      { icon: 'bars', text: '1d 21h 30m' },
      { icon: 'angle', text: '45º' },
    ]);
  });

  it('has no rows when no stat is on', () => {
    expect(statsRows(input({ stats: none }))).toEqual([]);
  });

  it('leaves out the percent change from a price of zero', () => {
    const [price] = statsRows(input({ from: { price: 0, time: 0 } }));
    expect(price?.text).toBe('1237.5, 123750');
  });
});
