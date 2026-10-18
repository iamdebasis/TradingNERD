import { describe, expect, it } from 'vitest';
import { darkTheme } from '../theme/tokens';
import { toChartTheme } from './chartTheme';
import { chartRoute, DEFAULT_RESOLUTION, DEFAULT_SYMBOL } from './route';

describe('chartRoute', () => {
  it('defaults to BINANCE:XRPUSDT on the daily chart', () => {
    expect(chartRoute('')).toEqual({ symbol: DEFAULT_SYMBOL, resolution: DEFAULT_RESOLUTION });
    expect(DEFAULT_SYMBOL).toBe('BINANCE:XRPUSDT');
  });

  it("reads TradingView's own URL parameters", () => {
    expect(chartRoute('?symbol=BINANCE:BTCUSDT&interval=60')).toEqual({
      symbol: 'BINANCE:BTCUSDT',
      resolution: '60',
    });
    expect(chartRoute('?symbol=binance:ethusdt&interval=D')).toEqual({
      symbol: 'BINANCE:ETHUSDT',
      resolution: '1D',
    });
  });

  it('falls back per parameter when one is invalid', () => {
    expect(chartRoute('?symbol=nonsense&interval=240')).toEqual({
      symbol: DEFAULT_SYMBOL,
      resolution: '240',
    });
    expect(chartRoute('?symbol=BINANCE:SOLUSDT&interval=7X')).toEqual({
      symbol: 'BINANCE:SOLUSDT',
      resolution: DEFAULT_RESOLUTION,
    });
  });
});

describe('toChartTheme', () => {
  it('takes every chart color from the design tokens', () => {
    expect(toChartTheme(darkTheme)).toEqual({
      background: '#0F0F0F',
      grid: '#1C1C1C',
      axisText: '#B8B8B8',
      crosshair: '#9C9C9C',
      crosshairLabel: '#3D3D3D',
      labelText: '#FFFFFF',
      up: '#089981',
      down: '#F23645',
      fontFamily: darkTheme.font.family,
      fontSize: 12,
    });
  });
});
