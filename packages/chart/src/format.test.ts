import { parseResolution, type Resolution } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatCrosshairTime,
  formatPrice,
  formatSignedPercent,
  formatSignedPrice,
  formatTickMark,
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
