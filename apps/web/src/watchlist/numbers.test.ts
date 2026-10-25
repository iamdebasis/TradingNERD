import { describe, expect, it } from 'vitest';
import {
  directionOf,
  flashSplit,
  formatChange,
  formatChangePercent,
  formatLast,
  formatSpreadChange,
  groupThousands,
} from './numbers';

describe('watchlist numbers', () => {
  it('writes market caps and their changes in thousands to trillions (screenshots 20–22)', () => {
    expect(formatLast(2.652e12, 0, 'volume')).toBe('2.65T');
    expect(formatLast(758.92e9, 0, 'volume')).toBe('758.92B');
    expect(formatLast(245.77e6, 0, 'volume')).toBe('245.77M');
    expect(formatChange(-36.71e9, 0, 'volume')).toBe('−36.71B');
    expect(formatChange(4.2e9, 0, 'volume')).toBe('4.2B');
    // A dominance keeps its decimals: 60.73, 0.13.
    expect(formatLast(60.734, 2, 'price')).toBe('60.73');
    expect(formatChange(0.1309, 2, 'price')).toBe('0.13');
  });

  it("writes a formula's change in full, without trailing zeros (screenshot 22)", () => {
    expect(formatSpreadChange(-2_215_826_337.4, 0)).toBe('−2,215,826,337');
    expect(formatSpreadChange(-0.2, 2)).toBe('−0.2');
    expect(formatSpreadChange(-18, 2)).toBe('−18');
    expect(formatSpreadChange(0.1, 2)).toBe('0.1');
    expect(formatSpreadChange(0, 2)).toBe('0');
    // Smaller than its decimals show: its first digit, not a flat 0.
    expect(formatSpreadChange(-0.000123, 2)).toBe('−0.0001');
  });

  it('writes changes with a real minus and no plus, as TradingView does', () => {
    expect(formatChange(-0.403, 3)).toBe('−0.403');
    expect(formatChange(0.0101, 4)).toBe('0.0101');
    expect(formatChange(-0.000001, 4)).toBe('0.0000');
    expect(formatChangePercent(-3.2629)).toBe('−3.26%');
    expect(formatChangePercent(0.634)).toBe('0.63%');
  });

  it('cuts a change to 5 decimals, keeping its sign, as in the reference', () => {
    expect(formatChange(0.006731 - 0.006979, 6)).toBe('−0.00024'); // VET, not −0.00025
    expect(formatChange(0.084872 - 0.09447, 6)).toBe('−0.00959'); // MANA
    expect(formatChange(-0.0000001, 8)).toBe('−0.00000'); // SHIB
    expect(formatChange(0.00000001, 8)).toBe('0.00000');
    expect(formatChange(0, 8)).toBe('0.00000');
    expect(formatChange(-0.02495, 5)).toBe('−0.02495'); // BAT: 5 decimals stay whole
    // Chg% rounds: the reference's XCH, 0.0101 on 1.6051, is 0.63%.
    expect(formatChangePercent((0.0101 / 1.6051) * 100)).toBe('0.63%');
  });

  it('groups thousands with commas, as ZEC reads in docs/reference/05-watchlist-hover.png', () => {
    expect(formatLast(1_147.90345, 5)).toBe('1,147.90345');
    expect(formatLast(82_706.7, 1)).toBe('82,706.7');
    expect(formatLast(1_234_567.8, 1)).toBe('1,234,567.8');
    expect(formatLast(999.99, 2)).toBe('999.99');
    expect(formatLast(0.00000498, 8)).toBe('0.00000498');
    expect(formatChange(18.434081, 6)).toBe('18.43408');
    expect(formatChange(-1_234.5, 1)).toBe('−1,234.5');
    expect(formatChangePercent(1_234.567)).toBe('1,234.57%');
    expect(groupThousands('−1234')).toBe('−1,234');
    expect(groupThousands('123')).toBe('123');
  });

  it('colors by direction, treating what rounds to zero as flat', () => {
    expect(directionOf(0.0101, 4)).toBe('up');
    expect(directionOf(-0.4, 3)).toBe('down');
    expect(directionOf(0.00001, 4)).toBe('flat');
  });

  it('flashes the digits from the first one that changed', () => {
    expect(flashSplit('11.946', '11.947', 0.001)).toEqual({
      same: '11.94',
      changed: '7',
      direction: 'up',
    });
    expect(flashSplit('0.007412', '0.007405', -0.000007)).toEqual({
      same: '0.0074',
      changed: '05',
      direction: 'down',
    });
    expect(flashSplit('9.99', '10.01', 0.02)).toEqual({
      same: '',
      changed: '10.01',
      direction: 'up',
    });
  });

  it('flashes grouped prices from the first changed digit, commas included', () => {
    expect(flashSplit('1,147.903', '1,148.012', 0.109)).toEqual({
      same: '1,14',
      changed: '8.012',
      direction: 'up',
    });
  });

  it('shows the first price, or an unchanged one, plain', () => {
    expect(flashSplit(null, '1.2955', 0)).toEqual({
      same: '1.2955',
      changed: '',
      direction: 'flat',
    });
    expect(flashSplit('1.2955', '1.2955', 0)).toEqual({
      same: '1.2955',
      changed: '',
      direction: 'flat',
    });
  });
});
