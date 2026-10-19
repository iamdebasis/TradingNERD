import { describe, expect, it } from 'vitest';
import { directionOf, flashSplit, formatChange, formatChangePercent } from './numbers';

describe('watchlist numbers', () => {
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
