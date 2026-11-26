import { describe, expect, it } from 'vitest';
import { reorderDrawings } from './drawingOrder.ts';
import { type Drawing, type DrawingTool, newDrawing } from './drawings.ts';

/** A drawing on a pane (null: the price pane), under the bars or not. */
const make = (id: string, pane: string | null = null, below = false, tool: DrawingTool = 'ray') => {
  const drawing = newDrawing(
    id,
    tool,
    tool === 'vertical-line'
      ? [{ time: 1, price: 1 }]
      : [
          { time: 1, price: 1 },
          { time: 2, price: 2 },
        ],
    pane,
  );
  return { ...drawing, below };
};

/** The paint order, bottom first, with the bars between those under them and the rest. */
const stack = (drawings: readonly Drawing[]) => [
  ...drawings.filter((d) => d.below).map((d) => d.id),
  '|',
  ...drawings.filter((d) => !d.below).map((d) => d.id),
];

describe('visual order (D3a)', () => {
  const list = [make('a'), make('b'), make('c'), make('d')];

  it('brings drawings to the front over every other, keeping their own order', () => {
    expect(stack(reorderDrawings(list, ['b', 'a'], 'bring-to-front'))).toEqual([
      '|',
      'c',
      'd',
      'a',
      'b',
    ]);
  });

  it('sends drawings to the back under every other and under the bars', () => {
    const sent = reorderDrawings(list, ['c', 'b'], 'send-to-back');
    expect(stack(sent)).toEqual(['b', 'c', '|', 'a', 'd']);
    expect(sent.filter((d) => d.below).map((d) => d.id)).toEqual(['b', 'c']);
    // And to the front again, over the bars.
    expect(stack(reorderDrawings(sent, ['b'], 'bring-to-front'))).toEqual([
      'c',
      '|',
      'a',
      'd',
      'b',
    ]);
  });

  it('brings one forward past the next drawing, one step at a time', () => {
    const once = reorderDrawings(list, ['a'], 'bring-forward');
    expect(stack(once)).toEqual(['|', 'b', 'a', 'c', 'd']);
    expect(stack(reorderDrawings(once, ['a'], 'bring-forward'))).toEqual(['|', 'b', 'c', 'a', 'd']);
  });

  it('sends one backward past the next drawing, then under the bars', () => {
    const once = reorderDrawings(list, ['b'], 'send-backward');
    expect(stack(once)).toEqual(['|', 'b', 'a', 'c', 'd']);
    const under = reorderDrawings(once, ['b'], 'send-backward');
    expect(stack(under)).toEqual(['b', '|', 'a', 'c', 'd']);
    expect(under.find((d) => d.id === 'b')?.below).toBe(true);
    // Forward again from under the bars: over them, the lowest of those over them.
    expect(stack(reorderDrawings(under, ['b'], 'bring-forward'))).toEqual([
      '|',
      'b',
      'a',
      'c',
      'd',
    ]);
  });

  it('steps past drawings of its own pane only, other panes’ left where they are', () => {
    const panes = [make('a'), make('r1', 'rsi-1'), make('b'), make('r2', 'rsi-1')];
    expect(stack(reorderDrawings(panes, ['a'], 'bring-forward'))).toEqual([
      '|',
      'r1',
      'b',
      'a',
      'r2',
    ]);
    expect(stack(reorderDrawings(panes, ['r2'], 'send-backward'))).toEqual([
      '|',
      'a',
      'r2',
      'r1',
      'b',
    ]);
  });

  it('steps a vertical line, which crosses every pane, past the next of any pane', () => {
    const panes = [make('v', null, false, 'vertical-line'), make('r1', 'rsi-1'), make('b')];
    expect(stack(reorderDrawings(panes, ['v'], 'bring-forward'))).toEqual(['|', 'r1', 'v', 'b']);
  });

  it('moves several together, a block at the top staying put', () => {
    expect(stack(reorderDrawings(list, ['a', 'b'], 'bring-forward'))).toEqual([
      '|',
      'c',
      'a',
      'b',
      'd',
    ]);
    expect(stack(reorderDrawings(list, ['c', 'd'], 'send-backward'))).toEqual([
      '|',
      'a',
      'c',
      'd',
      'b',
    ]);
    expect(reorderDrawings(list, ['c', 'd'], 'bring-forward')).toBe(list);
  });

  it('gives the same list back when nothing moves', () => {
    expect(reorderDrawings(list, ['d'], 'bring-to-front')).toBe(list);
    expect(reorderDrawings(list, ['d'], 'bring-forward')).toBe(list);
    expect(reorderDrawings(list, ['zz'], 'send-to-back')).toBe(list);
    const under = [make('a', null, true), make('b')];
    expect(reorderDrawings(under, ['a'], 'send-to-back')).toBe(under);
    expect(reorderDrawings(under, ['a'], 'send-backward')).toBe(under);
  });

  it('keeps every drawing it doesn’t move as it was', () => {
    const moved = reorderDrawings(list, ['a'], 'bring-to-front');
    for (const drawing of moved.filter((d) => d.id !== 'a')) {
      expect(list).toContain(drawing);
    }
  });
});
