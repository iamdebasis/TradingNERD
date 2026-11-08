import {
  type DrawingSnapshot,
  EMPTY_DRAWINGS,
  LabelObject,
  LineObject,
  TableObject,
} from '@tradingnerd/pine';
import { describe, expect, it } from 'vitest';
import { type DrawingFrame, DrawingsPrimitive, logicalOf, textPx } from './DrawingsPrimitive';

/**
 * A script's drawings on the chart (Pine docs: Text and shapes, Lines and boxes, Tables). The
 * canvas is a recording fake: each test reads what was drawn where.
 */

/** Ten daily bars from 1 January 2026; bar i at x = 100 + 10·i, price p at y = 500 − p. */
const DAY = 86_400;
const T0 = 1_767_225_600;
const frame: DrawingFrame = {
  times: Array.from({ length: 10 }, (_, i) => T0 + i * DAY),
  bars: { high: (i) => 110 + i, low: (i) => 90 + i },
};

interface Call {
  op: string;
  args: unknown[];
  fillStyle?: unknown;
  strokeStyle?: unknown;
}

function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: '12px sans-serif' };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 });
      return (...args: unknown[]) => {
        calls.push({ op: key, args, fillStyle: target.fillStyle, strokeStyle: target.strokeStyle });
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  });
  return { calls, ctx };
}

function render(drawings: Partial<DrawingSnapshot>, size = { width: 400, height: 300 }) {
  const primitive = new DrawingsPrimitive('12px Trebuchet MS');
  primitive.attached({
    chart: {
      timeScale: () => ({ logicalToCoordinate: (logical: number) => 100 + logical * 10 }),
    },
    series: { priceToCoordinate: (price: number) => 500 - price },
    requestUpdate: () => {},
  } as never);
  primitive.update({ ...EMPTY_DRAWINGS, ...drawings }, frame);
  const { calls, ctx } = recorder();
  const renderer = primitive.paneViews()[0]?.renderer();
  renderer?.draw({
    useMediaCoordinateSpace: (f: (scope: unknown) => void) => f({ context: ctx, mediaSize: size }),
  } as never);
  return calls;
}

describe('where drawings go', () => {
  it('takes a bar index as it is, and places a time between and past the bars', () => {
    expect(logicalOf(3, 'bar_index', frame.times)).toBe(3);
    expect(logicalOf((T0 + 2 * DAY) * 1000, 'bar_time', frame.times)).toBe(2);
    expect(logicalOf((T0 + 2.5 * DAY) * 1000, 'bar_time', frame.times)).toBe(2.5);
    // Past the last bar, at the bars' spacing (500 bars forward are allowed: Limitations).
    expect(logicalOf((T0 + 12 * DAY) * 1000, 'bar_time', frame.times)).toBe(12);
    expect(logicalOf(Number.NaN, 'bar_index', frame.times)).toBeNull();
  });

  it('sizes text by size.* name or by points (v6), provisional', () => {
    expect([
      textPx('tiny'),
      textPx('small'),
      textPx('normal'),
      textPx('large'),
      textPx('huge'),
    ]).toEqual([8, 10, 12, 16, 24]);
    expect(textPx(18)).toBe(24);
  });
});

describe('labels', () => {
  it('draws a bubble pointing down at its point, its text inside', () => {
    const label = Object.assign(new LabelObject(), { x: 4, y: 200, text: 'Hi' });
    const calls = render({ labels: [label] });
    const text = calls.find((c) => c.op === 'fillText');
    expect(text?.args[0]).toBe('Hi');
    // At x = 140; above the point at y = 300, the pointer between.
    expect(text?.args[1]).toBe(140);
    expect(text?.args[2] as number).toBeLessThan(300);
    expect(calls.some((c) => c.op === 'arcTo')).toBe(true);
  });

  it('stands above the bar’s high at yloc.abovebar, whatever its price', () => {
    const label = Object.assign(new LabelObject(), {
      x: 2,
      y: Number.NaN,
      yloc: 'abovebar',
      text: 'A',
    });
    const calls = render({ labels: [label] });
    const text = calls.find((c) => c.op === 'fillText');
    // The bar's high is 112: y = 388; the bubble above it.
    expect(text?.args[2] as number).toBeLessThan(388);
  });

  it('draws nothing for a label at na', () => {
    const label = Object.assign(new LabelObject(), { x: Number.NaN, y: 200, text: 'x' });
    expect(render({ labels: [label] }).filter((c) => c.op === 'fillText')).toEqual([]);
  });
});

describe('lines', () => {
  it('runs between its two points, and on to the pane’s edge when extended right', () => {
    const line = Object.assign(new LineObject(), { x1: 0, y1: 100, x2: 4, y2: 104 });
    const plain = render({ lines: [line] });
    expect(plain.find((c) => c.op === 'moveTo')?.args).toEqual([100, 400]);
    expect(plain.find((c) => c.op === 'lineTo')?.args).toEqual([140, 396]);
    const extended = render({ lines: [Object.assign(line, { extend: 'right' })] });
    // The slope carries on: −0.1 px per px, to x = 400.
    expect(extended.find((c) => c.op === 'lineTo')?.args).toEqual([400, 370]);
  });

  it('dashes and dots as its style says', () => {
    const line = Object.assign(new LineObject(), {
      x1: 0,
      y1: 100,
      x2: 4,
      y2: 104,
      style: 'dashed',
      width: 2,
    });
    expect(render({ lines: [line] }).find((c) => c.op === 'setLineDash')?.args[0]).toEqual([8, 6]);
  });
});

describe('tables', () => {
  it('sits at its corner, its cells sized to their text', () => {
    const table = Object.assign(new TableObject(), {
      position: 'bottom_right',
      columns: 1,
      rows: 1,
      cells: [
        [
          {
            text: 'Cell',
            width: 0,
            height: 0,
            textColor: 0xff000000,
            textHalign: 'center',
            textValign: 'center',
            textSize: 'normal',
            bgcolor: Number.NaN,
            tooltip: '',
            font: 'default',
            formatting: 0,
          },
        ],
      ],
    });
    const calls = render({ tables: [table] }, { width: 400, height: 300 });
    const text = calls.find((c) => c.op === 'fillText');
    expect(text?.args[0]).toBe('Cell');
    // 4 letters at 6 px each, padded 6 px either side: 36 px wide, centred at 400 − 18.
    expect(text?.args[1]).toBe(382);
    expect(text?.args[2] as number).toBeGreaterThan(280);
  });
});
