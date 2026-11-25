import { describe, expect, it } from 'vitest';
import {
  DRAWING_BLUE,
  defaultDrawingStyle,
  defaultVisibility,
  drawingsKey,
  MAX_DRAWING_TEXT,
  MAX_DRAWINGS_PER_SYMBOL,
  newDrawing,
  parseDrawing,
  parseDrawingsFile,
  parseSymbolDrawings,
  visibilityRowOf,
  visibleOn,
} from './drawings.ts';
import { parseResolution } from './resolution.ts';

const res = (text: string) => {
  const parsed = parseResolution(text);
  if (!parsed) throw new Error(`not an interval: ${text}`);
  return parsed;
};

const line = () =>
  newDrawing('d1', 'trend-line', [
    { time: 1_700_000_000, price: 1.5 },
    { time: 1_700_086_400, price: 1.7 },
  ]);

describe('a tool starts with TradingView’s style (provisional, §11)', () => {
  it('draws the line tools in TradingView’s blue at 2 px, solid', () => {
    for (const tool of ['trend-line', 'ray', 'horizontal-line', 'vertical-line'] as const) {
      const style = defaultDrawingStyle(tool);
      expect([style.color, style.width, style.lineStyle]).toEqual([DRAWING_BLUE, 2, 'solid']);
    }
  });

  it('extends a ray to the right and an extended line both ways; a trendline not at all', () => {
    const extend = (tool: Parameters<typeof defaultDrawingStyle>[0]) => {
      const style = defaultDrawingStyle(tool);
      return [style.extendLeft, style.extendRight];
    };
    expect(extend('trend-line')).toEqual([false, false]);
    expect(extend('ray')).toEqual([false, true]);
    expect(extend('extended-line')).toEqual([true, true]);
  });

  it('shows every stat on an info line, always; none on a trendline', () => {
    const info = defaultDrawingStyle('info-line');
    expect(Object.values(info.stats).every(Boolean)).toBe(true);
    expect(info.alwaysShowStats).toBe(true);
    expect(Object.values(defaultDrawingStyle('trend-line').stats).some(Boolean)).toBe(false);
  });

  it('labels a horizontal line’s price, a vertical line’s time and both on a crossline', () => {
    const labels = (tool: Parameters<typeof defaultDrawingStyle>[0]) => {
      const style = defaultDrawingStyle(tool);
      return [style.showPrice, style.showTime];
    };
    expect(labels('horizontal-line')).toEqual([true, false]);
    expect(labels('horizontal-ray')).toEqual([true, false]);
    expect(labels('vertical-line')).toEqual([false, true]);
    expect(labels('cross-line')).toEqual([true, true]);
  });

  it('gives each drawing its own style, not a shared one', () => {
    const a = newDrawing('a', 'ray', [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ]);
    const b = newDrawing('b', 'ray', [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ]);
    a.style.stats.angle = true;
    expect(b.style.stats.angle).toBe(false);
  });
});

describe('a stored drawing', () => {
  it('reads back as it was written', () => {
    const drawing = line();
    drawing.style.text.value = 'Breakout';
    drawing.locked = true;
    expect(parseDrawing(JSON.parse(JSON.stringify(drawing)))).toEqual(drawing);
  });

  it('is refused with the wrong number of points, a bad number, an unknown tool or id', () => {
    const base = JSON.parse(JSON.stringify(line()));
    expect(parseDrawing({ ...base, points: [base.points[0]] })).toBeNull();
    expect(parseDrawing({ ...base, points: [base.points[0], { time: 1, price: NaN }] })).toBeNull();
    expect(parseDrawing({ ...base, tool: 'fib-retracement' })).toBeNull();
    expect(parseDrawing({ ...base, id: 'a b' })).toBeNull();
    expect(parseDrawing({ ...base, pane: '' })).toBeNull();
  });

  it('takes its tool’s defaults for a style field that’s missing or wrong, so older files read', () => {
    const base = JSON.parse(JSON.stringify(line()));
    const parsed = parseDrawing({
      ...base,
      style: { color: 'blue', width: 7, lineStyle: 'wavy', text: { size: 'big' } },
    });
    expect(parsed?.style).toEqual(defaultDrawingStyle('trend-line'));
  });

  it('keeps a text up to its limit', () => {
    const base = JSON.parse(JSON.stringify(line()));
    base.style.text.value = 'x'.repeat(MAX_DRAWING_TEXT + 10);
    expect(parseDrawing(base)?.style.text.value).toHaveLength(MAX_DRAWING_TEXT);
  });

  it('sits on an indicator’s pane by the indicator’s id', () => {
    const base = JSON.parse(JSON.stringify(line()));
    expect(parseDrawing({ ...base, pane: 'rsi-1' })?.pane).toBe('rsi-1');
  });
});

describe('a symbol’s drawings', () => {
  it('belong to the symbol as the chart names it, case aside', () => {
    expect(drawingsKey(' binance:xrpusdt ')).toBe('BINANCE:XRPUSDT');
    expect(parseSymbolDrawings({ symbol: 'binance:xrpusdt', drawings: [line()] })?.symbol).toBe(
      'BINANCE:XRPUSDT',
    );
  });

  it('are refused with two drawings of one id, or more than the limit', () => {
    expect(parseSymbolDrawings({ symbol: 'A', drawings: [line(), line()] })).toBeNull();
    const many = Array.from({ length: MAX_DRAWINGS_PER_SYMBOL + 1 }, (_, i) => ({
      ...line(),
      id: `d${i}`,
    }));
    expect(parseSymbolDrawings({ symbol: 'A', drawings: many })).toBeNull();
  });

  it('are kept in the file by symbol, a symbol without any left out', () => {
    const file = parseDrawingsFile({ version: 1, symbols: { 'binance:btcusdt': [line()], X: [] } });
    expect(Object.keys(file?.symbols ?? {})).toEqual(['BINANCE:BTCUSDT']);
    expect(parseDrawingsFile({ version: 2, symbols: {} })).toBeNull();
  });
});

describe('visibility on intervals (the Visibility tab)', () => {
  it('reads an interval as the row TradingView lists it under', () => {
    expect(visibilityRowOf(res('5'))).toEqual(['minutes', 5]);
    expect(visibilityRowOf(res('60'))).toEqual(['hours', 1]);
    expect(visibilityRowOf(res('240'))).toEqual(['hours', 4]);
    expect(visibilityRowOf(res('90'))).toEqual(['hours', 1.5]);
    expect(visibilityRowOf(res('1D'))).toEqual(['days', 1]);
    expect(visibilityRowOf(res('1W'))).toEqual(['weeks', 1]);
    expect(visibilityRowOf(res('3M'))).toEqual(['months', 3]);
    expect(visibilityRowOf(res('5S'))).toEqual(['seconds', 5]);
    expect(visibilityRowOf(res('100T'))).toEqual(['ticks', 100]);
  });

  it('shows a new drawing on every interval', () => {
    const all = defaultVisibility();
    for (const text of ['1', '45', '60', '90', '720', '1D', '365D', '1W', '12M', '1S', '10T']) {
      expect(visibleOn(all, res(text))).toBe(true);
    }
  });

  it('hides it on a row turned off, or outside its row’s range', () => {
    const rows = defaultVisibility();
    rows.minutes.on = false;
    rows.hours = { on: true, from: 1, to: 4 };
    expect(visibleOn(rows, res('15'))).toBe(false);
    expect(visibleOn(rows, res('60'))).toBe(true);
    expect(visibleOn(rows, res('240'))).toBe(true);
    expect(visibleOn(rows, res('720'))).toBe(false);
    expect(visibleOn(rows, res('1D'))).toBe(true);
  });
});
