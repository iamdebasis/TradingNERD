import { type Drawing, type DrawingTool, newDrawing } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  displaceDrawings,
  severalStyle,
  withFill,
  withLine,
  withLineColor,
  withTextColor,
} from './severalStyle';

const make = (id: string, tool: DrawingTool, color = '#2962FF'): Drawing => {
  const points = Array.from({ length: tool === 'parallel-channel' ? 3 : 2 }, (_, i) => ({
    time: 600 + i * 60,
    price: 10 + i,
  }));
  const drawing = newDrawing(id, tool, points);
  return { ...drawing, style: { ...drawing.style, color } };
};

describe('several drawings’ style (D3c2)', () => {
  const line = make('a', 'trend-line', '#2962FF');
  const channel = make('b', 'parallel-channel', '#F23645');
  const pitchfork = make('c', 'pitchfork', '#2962FF');

  it('offers Line, and Background and Text when any drawing has one', () => {
    const look = severalStyle([line, pitchfork]);
    expect(look.line?.color).toEqual({ value: '#2962FF', mixed: false });
    // The pitchfork has a background and no text; the trend line text and no background.
    expect(look.fill?.on.value).toBe(pitchfork.style.fill.on);
    expect(look.text).toEqual({ value: line.style.text.color, mixed: false });
  });

  it('says where they differ, the first’s value shown', () => {
    const look = severalStyle([line, channel]);
    expect(look.line?.color).toEqual({ value: '#2962FF', mixed: true });
    expect(look.fill?.color.mixed).toBe(false);
  });

  it('sets each drawing that has the value, leaving the others', () => {
    const set = withLineColor([line, channel], '#089981');
    expect(set.map((d) => d.style.color)).toEqual(['#089981', '#089981']);
    expect(withLine([line, channel], { width: 3 }).map((d) => d.style.width)).toEqual([3, 3]);
    const filled = withFill([line, channel], { on: false, color: '#FFEB3B33' });
    expect(filled[0]).toBe(line);
    expect(filled[1]?.style.fill).toEqual({ on: false, color: '#FFEB3B33' });
    const texted = withTextColor([line, pitchfork], '#FF9800');
    expect(texted[0]?.style.text.color).toBe('#FF9800');
    expect(texted[1]).toBe(pitchfork);
  });
});

describe('Displacement (D3c2)', () => {
  // A chart of minute bars: bar n at time 60 n.
  const chart = {
    drawingBarOf: (time: number) => Math.round(time / 60),
    drawingTimeOf: (bar: number) => bar * 60,
  };
  const line = make('a', 'trend-line');
  const locked = { ...make('b', 'trend-line'), locked: true };

  it('moves every point of every drawing by the price expression', () => {
    const [moved] = displaceDrawings([line], 'price', { op: '+', value: 5 }, chart);
    expect(moved?.points.map((p) => p.price)).toEqual([15, 16]);
    const [halved] = displaceDrawings([line], 'price', { op: '/', value: 2 }, chart);
    expect(halved?.points.map((p) => p.price)).toEqual([5, 5.5]);
    const [set] = displaceDrawings([line], 'price', { op: '=', value: 7 }, chart);
    expect(set?.points.map((p) => p.price)).toEqual([7, 7]);
  });

  it('moves them by bars through the chart’s bars', () => {
    const [moved] = displaceDrawings([line], 'bar', { op: '+', value: 2 }, chart);
    expect(moved?.points.map((p) => p.time)).toEqual([720, 780]);
    const [back] = displaceDrawings([line], 'bar', { op: '-', value: 1 }, chart);
    expect(back?.points.map((p) => p.time)).toEqual([540, 600]);
  });

  it('leaves a locked drawing where it is, and bars alone without a chart', () => {
    expect(displaceDrawings([locked], 'price', { op: '+', value: 5 }, chart)[0]).toBe(locked);
    expect(displaceDrawings([line], 'bar', { op: '+', value: 1 }, null)[0]).toBe(line);
  });
});
