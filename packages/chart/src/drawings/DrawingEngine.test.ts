import {
  type Bar,
  type Drawing,
  type DrawingPoint,
  type DrawingTool,
  newDrawing,
  type Resolution,
} from '@tradingnerd/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { DrawingEngine, type DrawingHost, type PointerInput } from './DrawingEngine';

const T0 = 1_700_000_000;
const STEP = 60;
const at = (bar: number) => T0 + bar * STEP;

// Minute bars: bar i opens at 100 + i, its high 110 + i, low 90 + i and close 105 + i.
const BARS: Bar[] = Array.from({ length: 100 }, (_, i) => ({
  time: at(i),
  open: 100 + i,
  high: 110 + i,
  low: 90 + i,
  close: 105 + i,
  volume: 1,
}));

/**
 * A chart of two panes: the price pane (800 × 500, a price p at y = 500 − p) and an RSI pane
 * (800 × 200, a value v at y = 200 − 2v). Bar i is at x = 10i + 5.
 */
class FakeHost implements DrawingHost {
  panning: boolean[] = [];
  cursor: string | null = null;
  updates = 0;
  interval: Resolution = { unit: 'minute', count: 1 };
  panes: { key: string | null; height: number }[] = [
    { key: null, height: 500 },
    { key: 'rsi', height: 200 },
  ];
  logicalToX(logical: number) {
    return 10 * logical + 5;
  }
  xToLogical(x: number) {
    return (x - 5) / 10;
  }
  priceToY(pane: number, price: number) {
    return pane === 0 ? 500 - price : 200 - 2 * price;
  }
  yToPrice(pane: number, y: number) {
    return pane === 0 ? 500 - y : (200 - y) / 2;
  }
  paneKey(pane: number) {
    return this.panes[pane]?.key;
  }
  paneIndex(key: string | null) {
    const index = this.panes.findIndex((pane) => pane.key === key);
    return index < 0 ? null : index;
  }
  paneSize(pane: number) {
    const found = this.panes[pane];
    return found ? { width: 800, height: found.height } : null;
  }
  /** The chart's bars: a test may replace the last, as a live tick does. */
  series: Bar[] = BARS;
  bars() {
    return this.series;
  }
  resolution() {
    return this.interval;
  }
  /** The history asked for (bars before the first), and whether there's none older. */
  asked: number[] = [];
  ended = false;
  needHistory(bars: number) {
    this.asked.push(bars);
  }
  historyEnded() {
    return this.ended;
  }
  requestUpdate() {
    this.updates++;
  }
  setPanning(enabled: boolean) {
    this.panning.push(enabled);
  }
  setCursor(cursor: string | null) {
    this.cursor = cursor;
  }
}

let host: FakeHost;
let engine: DrawingEngine;
let edits: Drawing[][];
let selections: string[][];
let toolDone: number;
let ids: number;

beforeEach(() => {
  host = new FakeHost();
  edits = [];
  selections = [];
  toolDone = 0;
  ids = 0;
  engine = new DrawingEngine(host, {
    onEdit: (drawings) => edits.push(drawings),
    onSelect: (selected) => selections.push([...selected]),
    onToolDone: () => toolDone++,
    newId: () => `n${++ids}`,
  });
});

const input = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
  pane: 0,
  x,
  y,
  shift: false,
  mod: false,
  ...extra,
});

/** A press and its release at one place. */
function click(x: number, y: number, extra: Partial<PointerInput> = {}): void {
  engine.pointerDown(input(x, y, extra));
  engine.pointerUp(input(x, y, extra));
}

/** A press, moves to each place in turn with the button down, and the release at the last. */
function drag(from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}) {
  const taken = engine.pointerDown(input(from[0], from[1], extra));
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    engine.pointerMove(input(x, y, extra), true);
  }
  engine.pointerUp(input(to[0], to[1], extra));
  return taken;
}

const lastEdit = () => edits.at(-1) ?? [];

/** A drawing placed by the tests' own hand, at bars and prices. */
function given(
  id: string,
  tool: DrawingTool,
  points: [number, number][],
  options: Partial<Drawing> = {},
): Drawing {
  const anchors: DrawingPoint[] = points.map(([bar, price]) => ({ time: at(bar), price }));
  return { ...newDrawing(id, tool, anchors), ...options };
}

describe('placing a drawing', () => {
  it('places a trend line with a click, a move and a click, at its bars’ times and prices', () => {
    engine.setSettings({ tool: 'trend-line' });
    click(105, 300);
    engine.pointerMove(input(205, 250), false);
    // The second point follows the pointer before the second click.
    expect(engine.debug().placing?.points).toEqual([
      { time: at(10), price: 200 },
      { time: at(20), price: 250 },
    ]);
    click(205, 250);
    expect(edits).toHaveLength(1);
    const [line] = lastEdit();
    expect(line?.tool).toBe('trend-line');
    expect(line?.pane).toBeNull();
    expect(line?.points).toEqual([
      { time: at(10), price: 200 },
      { time: at(20), price: 250 },
    ]);
    expect(engine.selection()).toEqual(['n1']);
    expect(toolDone).toBe(1);
  });

  it('places a trend line in one press, drag and release', () => {
    engine.setSettings({ tool: 'trend-line' });
    drag([105, 300], [305, 100]);
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(10), price: 200 },
      { time: at(30), price: 400 },
    ]);
  });

  it('draws nothing for two points in one place, and gives the cursor back', () => {
    engine.setSettings({ tool: 'trend-line' });
    click(105, 300);
    click(105, 300);
    expect(edits).toHaveLength(0);
    expect(toolDone).toBe(1);
  });

  it('keeps the tool after each drawing while Keep drawing is on', () => {
    engine.setSettings({ tool: 'horizontal-line', keepDrawing: true });
    click(105, 300);
    click(205, 200);
    expect(lastEdit()).toHaveLength(2);
    expect(toolDone).toBe(0);
  });

  it('places a horizontal line with one click, across the whole pane, its handle at 90%', () => {
    engine.setSettings({ tool: 'horizontal-line' });
    click(305, 120);
    expect(lastEdit()[0]?.points).toEqual([{ time: at(30), price: 380 }]);
    const [shape] = engine.shapes(0);
    expect(shape?.lines).toEqual([
      [
        { x: -4, y: 120 },
        { x: 804, y: 120 },
      ],
    ]);
    expect(shape?.handles).toEqual([{ x: 720, y: 120, point: 0, square: true }]);
  });

  it('places a drawing on the indicator pane it was drawn in', () => {
    engine.setSettings({ tool: 'horizontal-ray' });
    engine.pointerDown(input(105, 60, { pane: 1 }));
    engine.pointerUp(input(105, 60, { pane: 1 }));
    expect(lastEdit()[0]).toMatchObject({ pane: 'rsi', points: [{ time: at(10), price: 70 }] });
    expect(engine.shapes(0)).toHaveLength(0);
    expect(engine.shapes(1)).toHaveLength(1);
  });

  it('lets go of a drawing being placed on Escape, and the tool with it', () => {
    engine.setSettings({ tool: 'trend-line' });
    click(105, 300);
    expect(engine.cancel()).toBe(true);
    expect(engine.debug().placing).toBeNull();
    expect(edits).toHaveLength(0);
    expect(toolDone).toBe(1);
  });
});

describe('the magnet', () => {
  // Bar 10's high is 120, at y = 380.
  it('weak mode snaps to the bar’s nearest price within 12 px, and only then', () => {
    engine.setSettings({
      tool: 'horizontal-line',
      magnetOn: true,
      magnet: 'weak',
      keepDrawing: true,
    });
    click(105, 377);
    click(105, 360);
    expect(lastEdit().map((drawing) => drawing.points[0]?.price)).toEqual([120, 140]);
  });

  it('strong mode snaps from anywhere', () => {
    engine.setSettings({ tool: 'horizontal-line', magnetOn: true, magnet: 'strong' });
    click(105, 300);
    expect(lastEdit()[0]?.points[0]?.price).toBe(120);
  });

  it('is turned off by Ctrl/⌘ while it’s on, and on while it’s off', () => {
    engine.setSettings({
      tool: 'horizontal-line',
      magnetOn: true,
      magnet: 'weak',
      keepDrawing: true,
    });
    click(105, 377, { mod: true });
    engine.setSettings({ magnetOn: false });
    click(105, 377, { mod: true });
    expect(lastEdit().map((drawing) => drawing.points[0]?.price)).toEqual([123, 120]);
  });
});

describe('Shift', () => {
  it('keeps the second point at a 45° step from the first', () => {
    engine.setSettings({ tool: 'trend-line' });
    click(105, 300);
    click(205, 205, { shift: true });
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(10), price: 200 },
      { time: at(20), price: 300 },
    ]);
  });
});

describe('editing', () => {
  const line = () =>
    given('a', 'trend-line', [
      [10, 200],
      [20, 250],
    ]);

  it('moves only the point whose handle is dragged', () => {
    engine.setDrawings([line()]);
    engine.select(['a']);
    drag([205, 250], [305, 150]);
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(10), price: 200 },
      { time: at(30), price: 350 },
    ]);
  });

  it('moves the whole drawing by whole bars and the pointer’s own pixels', () => {
    engine.setDrawings([line()]);
    expect(drag([155, 275], [175, 255])).toBe(true);
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(12), price: 220 },
      { time: at(22), price: 270 },
    ]);
    expect(engine.selection()).toEqual(['a']);
  });

  it('clones a drawing dragged with Ctrl/⌘, moving the copy', () => {
    engine.setDrawings([line()]);
    drag([155, 275], [175, 255], { mod: true });
    const [original, copy] = lastEdit();
    expect(original).toEqual(line());
    expect(copy?.id).toBe('n1');
    expect(copy?.points[0]).toEqual({ time: at(12), price: 220 });
    expect(engine.selection()).toEqual(['n1']);
  });

  it('puts a dragged drawing back on Escape', () => {
    engine.setDrawings([line()]);
    engine.pointerDown(input(155, 275));
    engine.pointerMove(input(185, 245), true);
    expect(engine.cancel()).toBe(true);
    engine.pointerUp(input(185, 245));
    expect(edits).toHaveLength(0);
    expect(engine.shapes(0)[0]?.points[0]).toEqual({ x: 105, y: 300 });
  });

  it('selects a locked drawing but neither moves nor deletes it', () => {
    engine.setDrawings([{ ...line(), locked: true }]);
    drag([155, 275], [205, 200]);
    expect(engine.selection()).toEqual(['a']);
    expect(engine.removeSelected()).toBe(false);
    expect(edits).toHaveLength(0);
  });

  it('keeps every drawing still and in place while Lock all is on', () => {
    engine.setDrawings([line()]);
    engine.setSettings({ lockAll: true });
    drag([155, 275], [205, 200]);
    expect(engine.removeSelected()).toBe(false);
    expect(edits).toHaveLength(0);
  });

  it('deletes the selected drawings', () => {
    engine.setDrawings([line(), given('b', 'horizontal-line', [[5, 100]])]);
    engine.select(['a']);
    expect(engine.removeSelected()).toBe(true);
    expect(lastEdit().map((drawing) => drawing.id)).toEqual(['b']);
    expect(engine.selection()).toEqual([]);
  });

  it('erases the drawing the eraser clicks', () => {
    engine.setDrawings([line()]);
    engine.setSettings({ cursor: 'eraser' });
    click(155, 275);
    expect(lastEdit()).toEqual([]);
  });

  it('moves a horizontal line only in price and a vertical line only in time', () => {
    engine.setDrawings([
      given('h', 'horizontal-line', [[10, 100]]),
      given('v', 'vertical-line', [[40, 100]]),
    ]);
    drag([555, 400], [575, 380]);
    drag([405, 250], [455, 200]);
    const [h, v] = lastEdit();
    expect(h?.points).toEqual([{ time: at(10), price: 120 }]);
    expect(v?.points).toEqual([{ time: at(45), price: 100 }]);
  });

  it('drops a selection whose drawing is gone', () => {
    engine.setDrawings([line()]);
    engine.select(['a']);
    engine.setDrawings([]);
    expect(engine.selection()).toEqual([]);
    expect(selections.at(-1)).toEqual([]);
  });
});

describe('what shows', () => {
  it('runs a ray from its first point through its second to the pane’s edge', () => {
    engine.setDrawings([
      given('r', 'ray', [
        [10, 200],
        [20, 250],
      ]),
    ]);
    const [segment] = engine.shapes(0)[0]?.lines ?? [];
    // Rising half a price a pixel, it leaves through the top edge.
    expect(segment?.[0]).toEqual({ x: 105, y: 300 });
    expect(segment?.[1]?.x).toBeCloseTo(713, 9);
    expect(segment?.[1]?.y).toBeCloseTo(-4, 9);
  });

  it('places a point past the last bar at the interval’s length', () => {
    engine.setDrawings([
      given('f', 'trend-line', [
        [90, 200],
        [104, 250],
      ]),
    ]);
    expect(engine.shapes(0)[0]?.points[1]).toEqual({ x: 1_045, y: 250 });
  });

  it('crosses every pane with a vertical line, but gives it a handle on its own only', () => {
    engine.setDrawings([{ ...given('v', 'vertical-line', [[10, 50]]), pane: 'rsi' }]);
    engine.select(['v']);
    const [onPrice] = engine.shapes(0);
    const [onRsi] = engine.shapes(1);
    expect(onPrice?.own).toBe(false);
    expect(onPrice?.handles).toEqual([]);
    expect(onRsi?.handles).toEqual([{ x: 105, y: 180, point: 0, square: true }]);
  });

  it('shows nothing of a drawing whose indicator pane is gone', () => {
    engine.setDrawings([{ ...given('m', 'vertical-line', [[10, 50]]), pane: 'macd' }]);
    expect(engine.shapes(0)).toEqual([]);
    expect(engine.shapes(1)).toEqual([]);
  });

  it('hides every drawing with Hide all, and a hidden one on its own', () => {
    const line = given('a', 'trend-line', [
      [10, 200],
      [20, 250],
    ]);
    engine.setDrawings([line, given('b', 'horizontal-line', [[5, 100]], { hidden: true })]);
    expect(engine.shapes(0).map((shape) => shape.drawing.id)).toEqual(['a']);
    engine.setSettings({ hideAll: true });
    expect(engine.shapes(0)).toEqual([]);
    expect(engine.hitTest(0, 155, 275)).toBeNull();
  });

  it('shows a drawing only on the intervals its Visibility tab leaves on', () => {
    const line = given('a', 'trend-line', [
      [10, 200],
      [20, 250],
    ]);
    line.visibility.minutes = { on: true, from: 5, to: 59 };
    engine.setDrawings([line]);
    expect(engine.shapes(0)).toEqual([]);
    host.interval = { unit: 'minute', count: 5 };
    expect(engine.shapes(0)).toHaveLength(1);
  });

  it('shows a hovered drawing’s handles unless it’s locked, and marks the handle under the pointer', () => {
    engine.setDrawings([
      given('a', 'trend-line', [
        [10, 200],
        [20, 250],
      ]),
    ]);
    engine.pointerMove(input(155, 275), false);
    const [shape] = engine.shapes(0);
    expect(shape && engine.showsHandles(shape.drawing)).toBe(true);
    engine.pointerMove(input(108, 302), false);
    expect(engine.hoveredHandle()).toEqual({ id: 'a', point: 0 });
    engine.setDrawings([
      given(
        'a',
        'trend-line',
        [
          [10, 200],
          [20, 250],
        ],
        { locked: true },
      ),
    ]);
    engine.pointerMove(input(155, 275), false);
    const [locked] = engine.shapes(0);
    expect(locked && engine.showsHandles(locked.drawing)).toBe(false);
  });

  it('puts an arrow at an end that has one', () => {
    const line = given('a', 'trend-line', [
      [10, 200],
      [20, 250],
    ]);
    line.style.rightEnd = 'arrow';
    engine.setDrawings([line]);
    expect(engine.shapes(0)[0]?.arrows).toEqual([
      [
        { x: 205, y: 250 },
        { x: 105, y: 300 },
      ],
    ]);
  });
});

describe('the chart around it', () => {
  it('pauses the chart’s panning while a drawing is drawn or dragged, and gives it back', () => {
    engine.setSettings({ tool: 'trend-line' });
    drag([105, 300], [205, 250]);
    expect(host.panning).toEqual([false, true]);
    drag([155, 275], [175, 255]);
    expect(host.panning).toEqual([false, true, false, true]);
  });

  it('leaves the chart to pan from where no drawing is', () => {
    engine.setDrawings([
      given('a', 'trend-line', [
        [10, 200],
        [20, 250],
      ]),
    ]);
    expect(engine.pointerDown(input(600, 50))).toBe(false);
    engine.pointerUp(input(600, 50));
    expect(host.panning).toEqual([]);
  });

  it('shows a crosshair while drawing, a pointer over a drawing, and the mode’s cursor else', () => {
    engine.setDrawings([
      given('a', 'trend-line', [
        [10, 200],
        [20, 250],
      ]),
    ]);
    engine.setSettings({ cursor: 'arrow' });
    expect(host.cursor).toBe('default');
    engine.pointerMove(input(155, 275), false);
    expect(host.cursor).toBe('pointer');
    engine.setSettings({ cursor: 'eraser' });
    expect(host.cursor).toBe('eraser');
    engine.pointerMove(input(600, 50), false);
    expect(host.cursor).toBe('eraser');
    engine.setSettings({ cursor: 'dot' });
    expect(host.cursor).toBe('dot');
    engine.setSettings({ cursor: 'cross' });
    expect(host.cursor).toBe('crosshair');
    engine.setSettings({ tool: 'ray' });
    engine.pointerMove(input(155, 275), false);
    expect(host.cursor).toBe('crosshair');
  });
});

describe('channels and pitchforks (D2)', () => {
  const shapeOf = (id: string) => engine.shapes(0).find((shape) => shape.drawing.id === id);

  it('places a parallel channel with three clicks, its third point kept at the first’s bar', () => {
    engine.setSettings({ tool: 'parallel-channel' });
    click(105, 200);
    engine.pointerMove(input(305, 100), false);
    // Until its second point is down, it shows as its first line, in its color.
    const preview = engine.shapes(0).find((shape) => shape.drawing.id === 'preview');
    expect([preview?.drawing.tool, preview?.drawing.style.color]).toEqual([
      'trend-line',
      '#2962FF',
    ]);
    click(305, 100);
    expect(edits).toHaveLength(0);
    expect(engine.debug().placing?.index).toBe(2);
    engine.pointerMove(input(205, 190), false);
    click(205, 190);
    // 40 px under the first line at bar 20: kept 40 under it at bar 10, at 300 − 40.
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(10), price: 300 },
      { time: at(30), price: 400 },
      { time: at(10), price: 260 },
    ]);
    expect(toolDone).toBe(1);
  });

  it('places a channel’s first line in one drag, then its third point with a click', () => {
    engine.setSettings({ tool: 'parallel-channel' });
    drag([105, 200], [305, 100]);
    expect(edits).toHaveLength(0);
    expect(engine.debug().placing?.index).toBe(2);
    engine.pointerMove(input(205, 190), false);
    click(205, 190);
    expect(lastEdit()[0]?.points.map((point) => point.price)).toEqual([300, 400, 260]);
  });

  it('places a pitchfork’s three points where they’re clicked', () => {
    engine.setSettings({ tool: 'pitchfork' });
    click(105, 300);
    click(205, 100);
    click(305, 200);
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(10), price: 200 },
      { time: at(20), price: 400 },
      { time: at(30), price: 300 },
    ]);
  });

  it('draws no channel whose first line’s two points are in one place', () => {
    engine.setSettings({ tool: 'parallel-channel' });
    click(105, 200);
    click(105, 200);
    click(205, 150);
    expect(edits).toHaveLength(0);
    expect(toolDone).toBe(1);
  });

  it('marks a parallel channel’s four corners on the axes', () => {
    engine.setDrawings([
      given('c', 'parallel-channel', [
        [10, 300],
        [30, 400],
        [10, 260],
      ]),
    ]);
    expect(shapeOf('c')?.axis.map((point) => [point.price, point.time])).toEqual([
      [300, at(10)],
      [400, at(30)],
      [260, at(10)],
      [360, at(30)],
    ]);
  });

  it('sets a parallel channel’s width by its second line’s middle handle', () => {
    engine.setDrawings([
      given('c', 'parallel-channel', [
        [10, 300],
        [30, 400],
        [10, 260],
      ]),
    ]);
    engine.select(['c']);
    // The second line's middle sits at bar 20, 40 px under the first line's (y 150).
    drag([205, 190], [205, 170]);
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(10), price: 300 },
      { time: at(30), price: 400 },
      { time: at(10), price: 280 },
    ]);
  });

  it('keeps a parallel channel’s width when its first point moves', () => {
    engine.setDrawings([
      given('c', 'parallel-channel', [
        [10, 300],
        [30, 400],
        [10, 260],
      ]),
    ]);
    engine.select(['c']);
    drag([105, 200], [125, 180]);
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(12), price: 320 },
      { time: at(30), price: 400 },
      { time: at(12), price: 280 },
    ]);
  });

  it('moves only a flat top/bottom’s flat price by its flat line’s handle', () => {
    engine.setDrawings([
      given('f', 'flat-top-bottom', [
        [10, 300],
        [30, 400],
        [30, 240],
      ]),
    ]);
    engine.select(['f']);
    drag([105, 260], [155, 280]);
    expect(lastEdit()[0]?.points).toEqual([
      { time: at(10), price: 300 },
      { time: at(30), price: 400 },
      { time: at(30), price: 220 },
    ]);
  });

  it('mirrors a disjoint channel’s second line’s start onto its first point', () => {
    engine.setDrawings([
      given('d', 'disjoint-channel', [
        [10, 300],
        [30, 400],
        [30, 240],
      ]),
    ]);
    engine.select(['d']);
    // Its second line runs from (105, 160) to (305, 260), the first's mirror.
    drag([105, 160], [105, 150]);
    expect(lastEdit()[0]?.points[0]).toEqual({ time: at(10), price: 290 });
    const start = shapeOf('d')?.handles.find((handle) => handle.point === 3);
    expect([start?.x, start?.y]).toEqual([105, 150]);
  });

  it('takes a click inside a channel’s background, but not inside a pitchfork’s', () => {
    engine.setDrawings([
      given('c', 'parallel-channel', [
        [10, 300],
        [30, 400],
        [10, 260],
      ]),
      given('p', 'pitchfork', [
        [50, 200],
        [60, 400],
        [70, 300],
      ]),
    ]);
    // Between the channel's first line (y 175 at bar 15) and its middle level (y 195).
    expect(engine.pointerDown(input(155, 185))).toBe(true);
    engine.pointerUp(input(155, 185));
    expect(engine.selection()).toEqual(['c']);
    // Inside the pitchfork's band between its median and its 0.5 level, off every line.
    const p = shapeOf('p');
    const band = p?.fills[0]?.points;
    expect(band).toBeDefined();
    const [a, b, c, d] = band ?? [];
    const inside = {
      x: ((a?.x ?? 0) + (b?.x ?? 0) + (c?.x ?? 0) + (d?.x ?? 0)) / 4,
      y: ((a?.y ?? 0) + (b?.y ?? 0) + (c?.y ?? 0) + (d?.y ?? 0)) / 4,
    };
    expect(engine.hitTest(0, inside.x, inside.y)).toBeNull();
  });

  it('fits a regression trend to the closes between its bars, its handles on the line', () => {
    engine.setSettings({ tool: 'regression-trend' });
    click(105, 300);
    click(305, 300);
    const [drawing] = lastEdit();
    expect(drawing?.points.map((point) => point.time)).toEqual([at(10), at(30)]);
    const shape = shapeOf(drawing?.id ?? '');
    // Closes 105 + i: a straight line from 115 at bar 10 to 135 at bar 30, no spread.
    expect(shape?.lines).toEqual([
      [
        { x: 105, y: 385 },
        { x: 305, y: 365 },
      ],
    ]);
    expect(shape?.handles.map(({ x, y, point }) => [x, y, point])).toEqual([
      [105, 385, 0],
      [305, 365, 1],
    ]);
    expect(shape?.label?.text).toBe('1');
    expect(shape?.axis.map((point) => point.price)).toEqual([115, 135]);
  });

  it('draws a regression trend only on the price pane', () => {
    engine.setSettings({ tool: 'regression-trend' });
    engine.pointerDown(input(105, 100, { pane: 1 }));
    engine.pointerUp(input(105, 100, { pane: 1 }));
    expect(engine.debug().placing).toBeNull();
    expect(edits).toHaveLength(0);
  });

  it('asks for the history a regression trend needs, and is worked out only once it’s all in', () => {
    engine.setDrawings([
      given('r', 'regression-trend', [
        [-20, 0],
        [10, 0],
      ]),
    ]);
    expect(host.asked).toEqual([20]);
    // Until then, only a line between its points: nothing worked out from part of its bars.
    expect(shapeOf('r')?.looks).toEqual([]);
    expect(shapeOf('r')?.label).toBeNull();
    // The exchange has none older: it's worked out on the bars there are.
    host.ended = true;
    engine.barsChanged();
    expect(host.asked).toEqual([20]);
    expect(shapeOf('r')?.axis.map((point) => point.price)).toEqual([105, 115]);
  });

  it('follows a live tick on its last bar, though nothing else changed', () => {
    host.series = BARS.slice();
    engine.setDrawings([
      given('r', 'regression-trend', [
        [90, 0],
        [99, 0],
      ]),
    ]);
    // Closes rising one a bar: a perfect line, Pearson's R 1.
    expect(shapeOf('r')?.label?.text).toBe('1');
    const last = host.series[99] as Bar;
    host.series[99] = { ...last, close: last.close - 50 };
    expect(shapeOf('r')?.label?.text).not.toBe('1');
  });

  it('asks for no more than its limit of history', () => {
    engine.setDrawings([
      given('r', 'regression-trend', [
        [-60_000, 0],
        [10, 0],
      ]),
    ]);
    expect(host.asked).toEqual([]);
  });
});
