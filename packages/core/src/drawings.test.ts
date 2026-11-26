import { describe, expect, it } from 'vitest';
import {
  CHANNEL_TOOLS,
  DRAWING_BLUE,
  DRAWING_RED,
  type DrawingLevel,
  type DrawingVisibility,
  defaultDrawingStyle,
  defaultVisibility,
  drawingsKey,
  intervalVisibility,
  MAX_DRAWING_TEXT,
  MAX_DRAWINGS_PER_SYMBOL,
  newDrawing,
  newDrawingId,
  PITCHFORK_TOOLS,
  parseDrawing,
  parseDrawingsFile,
  parseSymbolDrawings,
  recolorDrawing,
  TOOL_NAMES,
  TOOL_POINTS,
  TREND_LINE_TOOLS,
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

  it('sits over the bars unless sent under them, an older file’s over them (protocol 15)', () => {
    const base = JSON.parse(JSON.stringify(line()));
    expect(line().below).toBe(false);
    expect(parseDrawing({ ...base, below: true })?.below).toBe(true);
    delete base.below;
    expect(parseDrawing(base)?.below).toBe(false);
    expect(parseDrawing({ ...base, below: 'yes' })?.below).toBe(false);
  });
});

describe('a new drawing’s id', () => {
  it('is never the same twice, and is letters and digits as a stored id must be', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newDrawingId()));
    expect(ids.size).toBe(10_000);
    for (const id of [...ids].slice(0, 50)) {
      expect(parseDrawing({ ...JSON.parse(JSON.stringify(line())), id })?.id).toBe(id);
    }
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

describe('the Intervals visibility menu’s quick choices (D3a)', () => {
  const EVERY = ['1T', '10S', '1', '30', '60', '240', '720', '1D', '1W', '1M', '12M'];
  const shownOn = (rows: DrawingVisibility, list: readonly string[] = EVERY) =>
    list.filter((text) => visibleOn(rows, res(text)));
  const hiddenEverywhere = () => {
    const rows = defaultVisibility();
    for (const row of Object.values(rows)) row.on = false;
    return rows;
  };

  it('shows a drawing on 4 hours and longer with “Current interval and above” on 4h', () => {
    const rows = intervalVisibility('current-and-above', res('240'), defaultVisibility());
    expect(shownOn(rows)).toEqual(['240', '720', '1D', '1W', '1M', '12M']);
    expect(rows.hours).toEqual({ on: true, from: 4, to: 24 });
    expect(rows.minutes.on).toBe(false);
    expect(rows.days).toEqual({ on: true, from: 1, to: 366 });
  });

  it('shows it on 4 hours and shorter with “Current interval and below”', () => {
    const rows = intervalVisibility('current-and-below', res('240'), hiddenEverywhere());
    expect(shownOn(rows)).toEqual(['1T', '10S', '1', '30', '60', '240']);
    expect(rows.hours).toEqual({ on: true, from: 1, to: 4 });
    expect(rows.seconds).toEqual({ on: true, from: 1, to: 59 });
  });

  it('shows it on 4 hours alone with “Current interval only”', () => {
    const rows = intervalVisibility('current-only', res('240'), defaultVisibility());
    expect(shownOn(rows)).toEqual(['240']);
    expect(rows.hours).toEqual({ on: true, from: 4, to: 4 });
  });

  it('shows it everywhere again with “All intervals”', () => {
    expect(intervalVisibility('all', res('240'), hiddenEverywhere())).toEqual(defaultVisibility());
  });

  it('reads each interval in its own row: ticks, seconds, minutes, days and months', () => {
    const from = defaultVisibility();
    expect(shownOn(intervalVisibility('current-only', res('1'), from))).toEqual(['1']);
    expect(shownOn(intervalVisibility('current-only', res('10S'), from))).toEqual(['10S']);
    expect(shownOn(intervalVisibility('current-only', res('1T'), from))).toEqual(['1T']);
    expect(shownOn(intervalVisibility('current-and-above', res('1T'), from))).toEqual(EVERY);
    expect(shownOn(intervalVisibility('current-and-above', res('1D'), from))).toEqual([
      '1D',
      '1W',
      '1M',
      '12M',
    ]);
    expect(shownOn(intervalVisibility('current-and-below', res('1M'), from))).toEqual(
      EVERY.slice(0, -1),
    );
    expect(shownOn(intervalVisibility('current-and-above', res('12M'), from))).toEqual(['12M']);
  });

  it('keeps the counts around an interval that isn’t a whole one of its row (90 minutes)', () => {
    const only = intervalVisibility('current-only', res('90'), defaultVisibility());
    expect(only.hours).toEqual({ on: true, from: 1, to: 2 });
    expect(shownOn(only, ['30', '60', '90', '120', '180'])).toEqual(['60', '90', '120']);
    const above = intervalVisibility('current-and-above', res('90'), defaultVisibility());
    expect(shownOn(above, ['30', '90', '180', '1D'])).toEqual(['90', '180', '1D']);
  });

  it('leaves Ranges as it was, but for All intervals', () => {
    const from = hiddenEverywhere();
    expect(intervalVisibility('current-and-above', res('60'), from).ranges.on).toBe(false);
    from.ranges.on = true;
    expect(intervalVisibility('current-only', res('60'), from).ranges.on).toBe(true);
    expect(intervalVisibility('all', res('60'), hiddenEverywhere()).ranges.on).toBe(true);
  });
});

const channel = () =>
  newDrawing('c1', 'parallel-channel', [
    { time: 1_700_000_000, price: 10 },
    { time: 1_700_864_000, price: 20 },
    { time: 1_700_000_000, price: 14 },
  ]);

describe('the channels and pitchforks (D2)', () => {
  it('follow the Lines in TradingView’s menu, as the user’s screenshot names them', () => {
    expect(TREND_LINE_TOOLS.slice(9).map((tool) => TOOL_NAMES[tool])).toEqual([
      'Parallel channel',
      'Regression trend',
      'Flat top/bottom',
      'Disjoint channel',
      'Pitchfork',
      'Schiff pitchfork',
      'Modified Schiff pitchfork',
      'Inside pitchfork',
    ]);
  });

  it('take three points, but a regression trend two', () => {
    for (const tool of [...CHANNEL_TOOLS, ...PITCHFORK_TOOLS]) {
      expect(TOOL_POINTS[tool]).toBe(tool === 'regression-trend' ? 2 : 3);
    }
  });

  it('start a parallel channel blue at 2 px, filled at 20%, with only its dashed middle level on', () => {
    const style = defaultDrawingStyle('parallel-channel');
    expect([style.color, style.width, style.lineStyle]).toEqual([DRAWING_BLUE, 2, 'solid']);
    expect(style.fill).toEqual({ on: true, color: '#2962FF33' });
    expect(style.levels.map((level) => level.coeff)).toEqual([-0.25, 0.25, 0.5, 0.75, 1.25]);
    expect(style.levels.filter((level) => level.visible)).toEqual([
      { coeff: 0.5, visible: true, color: DRAWING_BLUE, width: 1, lineStyle: 'dashed' },
    ]);
    expect([style.text.alignH, style.text.alignV, style.text.size]).toEqual(['left', 'bottom', 14]);
  });

  it('start a regression trend at ±2 deviations of the closes, its base red and dashed', () => {
    const style = defaultDrawingStyle('regression-trend');
    expect([style.color, style.width, style.lineStyle]).toEqual([DRAWING_RED, 1, 'dashed']);
    const { regression } = style;
    expect([regression.upperDeviation, regression.lowerDeviation, regression.source]).toEqual([
      2,
      -2,
      'close',
    ]);
    expect([regression.useUpperDeviation, regression.useLowerDeviation]).toEqual([true, true]);
    expect(regression.up).toEqual({
      visible: true,
      color: DRAWING_BLUE,
      width: 2,
      lineStyle: 'solid',
    });
    expect(regression.down).toEqual(regression.up);
    expect(regression.showPearsons).toBe(true);
    expect(style.fill.color.slice(7)).toBe('4D');
  });

  it('start a flat top/bottom orange and a disjoint channel green, each filled at 20%', () => {
    expect(defaultDrawingStyle('flat-top-bottom').color).toBe('#FF9800');
    expect(defaultDrawingStyle('flat-top-bottom').fill).toEqual({ on: true, color: '#FF980033' });
    expect(defaultDrawingStyle('disjoint-channel').color).toBe('#089981');
    expect(defaultDrawingStyle('disjoint-channel').fill).toEqual({ on: true, color: '#08998133' });
  });

  it('start every pitchfork with a red median and its 0.5 and 1 levels on', () => {
    for (const tool of PITCHFORK_TOOLS) {
      const style = defaultDrawingStyle(tool);
      expect([style.color, style.width, style.lineVisible]).toEqual([DRAWING_RED, 2, true]);
      expect(style.levels).toHaveLength(9);
      expect(
        style.levels.filter((level) => level.visible).map((level) => [level.coeff, level.color]),
      ).toEqual([
        [0.5, '#089981'],
        [1, DRAWING_BLUE],
      ]);
      expect(style.fill).toEqual({ on: true, color: '#00000033' });
    }
  });

  it('read back as written, with their levels, fill and inputs', () => {
    const drawing = channel();
    drawing.style.levels[0] = {
      ...(drawing.style.levels[0] as DrawingLevel),
      visible: true,
      coeff: -0.5,
    };
    drawing.style.fill = { on: false, color: '#FF000080' };
    expect(parseDrawing(JSON.parse(JSON.stringify(drawing)))).toEqual(drawing);
    const regression = newDrawing('r1', 'regression-trend', [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ]);
    regression.style.regression.source = 'hlc3';
    regression.style.regression.useUpperDeviation = false;
    expect(parseDrawing(JSON.parse(JSON.stringify(regression)))).toEqual(regression);
  });

  it('read a D1 file’s drawing, written before these fields, with their defaults', () => {
    const stored = JSON.parse(JSON.stringify(line()));
    for (const key of ['lineVisible', 'extendLines', 'levels', 'fill', 'regression']) {
      delete stored.style[key];
    }
    expect(parseDrawing(stored)).toEqual(line());
  });

  it('keep a tool’s own number of levels, each bad value its default', () => {
    const stored = JSON.parse(JSON.stringify(channel()));
    stored.style.levels = [
      { coeff: 1e9, visible: 'yes', color: 'red', width: 9, lineStyle: 'wavy' },
      null,
      ...stored.style.levels.slice(2),
      { coeff: 3, visible: true, color: '#000000', width: 1, lineStyle: 'solid' },
    ];
    const levels = parseDrawing(stored)?.style.levels;
    const defaults = defaultDrawingStyle('parallel-channel').levels;
    expect(levels).toHaveLength(5);
    expect(levels?.[0]).toEqual({ ...defaults[0], coeff: 100 });
    expect(levels?.slice(1)).toEqual(defaults.slice(1));
  });

  it('are refused without their third point', () => {
    const stored = JSON.parse(JSON.stringify(channel()));
    expect(parseDrawing({ ...stored, points: stored.points.slice(0, 2) })).toBeNull();
  });
});

describe('one color for the whole drawing (the floating toolbar’s Line color)', () => {
  it('colors a line tool’s line and nothing else', () => {
    const recolored = recolorDrawing(line(), '#FF0000');
    expect(recolored.style).toEqual({ ...line().style, color: '#FF0000' });
  });

  it('colors a channel’s lines and levels, its background keeping its opacity, its text its color', () => {
    const recolored = recolorDrawing(channel(), '#FF0000');
    expect(recolored.style.color).toBe('#FF0000');
    expect(recolored.style.levels.every((level) => level.color === '#FF0000')).toBe(true);
    expect(recolored.style.fill.color).toBe('#FF000033');
    expect(recolored.style.text.color).toBe(DRAWING_BLUE);
    expect(channel().style.levels[2]?.color).toBe(DRAWING_BLUE);
  });

  it('colors a regression trend’s base, Up and Down lines', () => {
    const drawing = newDrawing('r', 'regression-trend', [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ]);
    const { style } = recolorDrawing(drawing, '#00FF00');
    expect([style.color, style.regression.up.color, style.regression.down.color]).toEqual([
      '#00FF00',
      '#00FF00',
      '#00FF00',
    ]);
  });
});
