import { parseResolution, type Resolution } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatCrosshairTime,
  formatPrice,
  formatSignedPercent,
  formatSignedPrice,
  formatSignedValue,
  formatTickMark,
  formatValue,
  formatVolume,
} from './format';

const MINUS = '−';
const res = (text: string): Resolution => {
  const parsed = parseResolution(text);
  if (!parsed) throw new Error(`bad resolution ${text}`);
  return parsed;
};
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000;

describe('price formatting', () => {
  it('uses the symbol precision', () => {
    expect(formatPrice(1.2955, 4)).toBe('1.2955');
    expect(formatPrice(1.3, 4)).toBe('1.3000');
    expect(formatPrice(108123.456, 2)).toBe('108123.46');
  });

  it('prints negatives with a true minus sign and never as −0', () => {
    expect(formatPrice(-0.5, 2)).toBe(`${MINUS}0.50`);
    expect(formatPrice(-0.00001, 4)).toBe('0.0000');
  });

  it('signs changes like the TradingView legend', () => {
    expect(formatSignedPrice(0.0106, 4)).toBe('+0.0106');
    expect(formatSignedPrice(-0.0163, 4)).toBe(`${MINUS}0.0163`);
    expect(formatSignedPrice(0, 4)).toBe('0.0000');
    expect(formatSignedPrice(-0.00001, 4)).toBe('0.0000');
  });

  it('signs percentages with two decimals', () => {
    expect(formatSignedPercent(2.7612)).toBe('+2.76%');
    expect(formatSignedPercent(-1.2345)).toBe(`${MINUS}1.23%`);
    expect(formatSignedPercent(0)).toBe('0.00%');
  });
});

describe('market caps in thousands to trillions', () => {
  it("writes TradingView's units with up to two decimals, trailing zeros dropped", () => {
    // From the user's screenshots 20–22.
    expect(formatVolume(2.652e12)).toBe('2.65T');
    expect(formatVolume(758.92e9)).toBe('758.92B');
    expect(formatVolume(213.6e9)).toBe('213.6B');
    expect(formatVolume(1.8e12)).toBe('1.8T');
    expect(formatVolume(3.8e9)).toBe('3.8B');
    expect(formatVolume(245.77e6)).toBe('245.77M');
    expect(formatVolume(142e6)).toBe('142M');
    expect(formatVolume(12_345)).toBe('12.35K');
    expect(formatVolume(523)).toBe('523');
    expect(formatVolume(0)).toBe('0');
  });

  it('moves to the next unit when rounding reaches a thousand', () => {
    expect(formatVolume(999.999e6)).toBe('1B');
    expect(formatVolume(999.996e9)).toBe('1T');
    expect(formatVolume(999.999)).toBe('1K');
  });

  it('signs a change with a true minus, and a plus in the legend', () => {
    expect(formatVolume(-36.71e9)).toBe(`${MINUS}36.71B`);
    expect(formatVolume(-0.001)).toBe('0');
    expect(formatSignedValue(-18.03e9, 0, 'volume')).toBe(`${MINUS}18.03B`);
    expect(formatSignedValue(2.11e9, 0, 'volume')).toBe('+2.11B');
    expect(formatSignedValue(0, 0, 'volume')).toBe('0');
  });

  it("follows the symbol's format, decimals otherwise", () => {
    expect(formatValue(2.652e12, 0, 'volume')).toBe('2.65T');
    expect(formatValue(1.2955, 4)).toBe('1.2955');
    expect(formatValue(60.734, 2, 'price')).toBe('60.73');
    expect(formatSignedValue(0.0106, 4)).toBe('+0.0106');
  });
});

describe('formatCrosshairTime', () => {
  // 2022-12-08 was a Thursday, as on the reference screenshot's time axis label.
  it('shows the date for daily and weekly bars', () => {
    expect(formatCrosshairTime(at('2022-12-08T00:00:00'), res('1D'))).toBe("Thu 08 Dec '22");
    expect(formatCrosshairTime(at('2022-12-05T00:00:00'), res('1W'))).toBe("Mon 05 Dec '22");
  });

  it('adds the UTC clock time for intraday bars', () => {
    expect(formatCrosshairTime(at('2022-12-08T14:35:00'), res('15'))).toBe("Thu 08 Dec '22  14:35");
    expect(formatCrosshairTime(at('2022-12-08T04:05:07'), res('1S'))).toBe(
      "Thu 08 Dec '22  04:05:07",
    );
  });

  it('shows month and year for monthly bars', () => {
    expect(formatCrosshairTime(at('2022-12-01T00:00:00'), res('1M'))).toBe("Dec '22");
    expect(formatCrosshairTime(at('2009-01-01T00:00:00'), res('1M'))).toBe("Jan '09");
  });
});

describe('formatCountdown', () => {
  it.each([
    [45_000, '00:45'],
    [59 * 60_000 + 59_000, '59:59'],
    [3_600_000, '01:00:00'],
    [(7 * 3600 + 50 * 60 + 6) * 1000, '07:50:06'],
    [(3 * 86_400 + 7 * 3600 + 50 * 60 + 6) * 1000, '3d 07:50:06'],
    [999, '00:00'],
    [-5_000, '00:00'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe('formatTickMark', () => {
  it("shows a tick bar's first trade as a UTC clock time", () => {
    expect(formatTickMark(Date.UTC(2026, 9, 18, 16, 9, 54, 321))).toBe('16:09:54');
    expect(formatTickMark(Date.UTC(2026, 9, 18, 0, 0, 5))).toBe('00:00:05');
  });
});
