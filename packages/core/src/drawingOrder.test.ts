import { describe, expect, it } from 'vitest';
import {
  availableMoves,
  moveItems,
  placeDrawings,
  reorderDrawings,
  reorderItems,
  VISUAL_ORDER_MOVES,
  VISUAL_ORDER_NAMES,
} from './drawingOrder.ts';
import { type Drawing, type DrawingGroup, type DrawingTool, newDrawing } from './drawings.ts';

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

describe('the Object tree’s drag (D3c)', () => {
  const ids = (list: readonly Drawing[]) => list.map((d) => `${d.id}${d.below ? '↓' : ''}`);
  const list = [make('u', null, true), make('a'), make('b'), make('c'), make('r', 'rsi-1')];

  it('puts drawings just behind another of their layer, keeping their own order', () => {
    expect(ids(placeDrawings(list, ['c', 'a'], { pane: null, below: false, before: 'b' }))).toEqual(
      ['u↓', 'a', 'c', 'b', 'r'],
    );
  });

  it('puts them at the front of a layer when there’s no drawing to go behind', () => {
    expect(ids(placeDrawings(list, ['a'], { pane: null, below: false, before: null }))).toEqual([
      'u↓',
      'b',
      'c',
      'r',
      'a',
    ]);
  });

  it('moves them under the bars, or over them, as the layer says', () => {
    const under = placeDrawings(list, ['b'], { pane: null, below: true, before: 'u' });
    expect(ids(under)).toEqual(['b↓', 'u↓', 'a', 'c', 'r']);
    expect(ids(placeDrawings(under, ['u'], { pane: null, below: false, before: null }))).toEqual([
      'b↓',
      'a',
      'c',
      'r',
      'u',
    ]);
  });

  it('leaves another pane’s drawings, and gives the same list back when nothing moves', () => {
    expect(placeDrawings(list, ['r'], { pane: null, below: false, before: null })).toBe(list);
    expect(placeDrawings(list, ['a'], { pane: null, below: false, before: 'a' })).toBe(list);
    expect(placeDrawings(list, ['a'], { pane: null, below: false, before: 'b' })).toBe(list);
    expect(placeDrawings(list, ['zz'], { pane: null, below: false, before: null })).toBe(list);
  });
});

describe('visual order with groups (D3c2)', () => {
  const g = (id: string): DrawingGroup => ({ id, name: id.toUpperCase() });
  const inGroups = (drawing: Drawing, ...groups: DrawingGroup[]) => ({ ...drawing, groups });
  const shape = (drawings: readonly Drawing[]) =>
    drawings.map(
      (d) =>
        `${d.below ? '↓' : ''}${d.id}${d.groups.length ? `(${d.groups.map((x) => x.id).join('/')})` : ''}`,
    );
  const list = [
    make('a'),
    inGroups(make('b'), g('g1')),
    inGroups(make('c'), g('g1')),
    make('d'),
    make('e'),
  ];
  const group = (id: string) => ({ kind: 'group' as const, id });
  const drawing = (id: string) => ({ kind: 'drawing' as const, id });

  it('lists the moves in TradingView’s submenu order', () => {
    expect(VISUAL_ORDER_MOVES.map((move) => VISUAL_ORDER_NAMES[move])).toEqual([
      'Bring to front',
      'Send to back',
      'Bring forward',
      'Send backward',
    ]);
  });

  it('moves a group as one, its drawings together', () => {
    expect(shape(reorderItems(list, [group('g1')], 'bring-to-front'))).toEqual([
      'a',
      'd',
      'e',
      'b(g1)',
      'c(g1)',
    ]);
    expect(shape(reorderItems(list, [group('g1')], 'bring-forward'))).toEqual([
      'a',
      'd',
      'b(g1)',
      'c(g1)',
      'e',
    ]);
    // Sent to back, under the bars with all its drawings.
    expect(shape(reorderItems(list, [group('g1')], 'send-to-back'))).toEqual([
      '↓b(g1)',
      '↓c(g1)',
      'a',
      'd',
      'e',
    ]);
  });

  it('steps a drawing past a whole group, never into it', () => {
    expect(shape(reorderItems(list, [drawing('a')], 'bring-forward'))).toEqual([
      'b(g1)',
      'c(g1)',
      'a',
      'd',
      'e',
    ]);
    expect(shape(reorderDrawings(list, ['d'], 'send-backward'))).toEqual([
      'a',
      'd',
      'b(g1)',
      'c(g1)',
      'e',
    ]);
  });

  it('moves a drawing in a group among the group’s own items only', () => {
    expect(shape(reorderItems(list, [drawing('b')], 'bring-to-front'))).toEqual([
      'a',
      'c(g1)',
      'b(g1)',
      'd',
      'e',
    ]);
    // Already at the group's front: nothing moves, even with drawings over the group.
    expect(reorderItems(list, [drawing('c')], 'bring-to-front')).toBe(list);
    expect(reorderItems(list, [drawing('c')], 'bring-forward')).toBe(list);
  });

  it('moves nothing for items in different groups, as TradingView’s menu has no Visual order then', () => {
    expect(reorderItems(list, [drawing('a'), drawing('b')], 'bring-to-front')).toBe(list);
    expect(reorderDrawings(list, ['c', 'e'], 'send-to-back')).toBe(list);
  });

  it('says which moves would change anything, for the greyed ones', () => {
    expect(availableMoves(list, [drawing('e')])).toEqual({
      'bring-to-front': false,
      'send-to-back': true,
      'bring-forward': false,
      'send-backward': true,
    });
    expect(availableMoves(list, [drawing('b')])).toEqual({
      'bring-to-front': true,
      'send-to-back': false,
      'bring-forward': true,
      'send-backward': false,
    });
  });
});

describe('the Object tree’s drag with groups (D3c2)', () => {
  const g = (id: string): DrawingGroup => ({ id, name: id.toUpperCase() });
  const inGroups = (drawing: Drawing, ...groups: DrawingGroup[]) => ({ ...drawing, groups });
  const shape = (drawings: readonly Drawing[]) =>
    drawings.map(
      (d) =>
        `${d.below ? '↓' : ''}${d.id}${d.groups.length ? `(${d.groups.map((x) => x.id).join('/')})` : ''}`,
    );
  const list = [
    make('u', null, true),
    make('a'),
    inGroups(make('b'), g('g1')),
    inGroups(make('c'), g('g1'), g('g2')),
    inGroups(make('d'), g('g1')),
    make('e'),
    make('r', 'rsi-1'),
  ];
  const group = (id: string) => ({ kind: 'group' as const, id });
  const drawing = (id: string) => ({ kind: 'drawing' as const, id });
  const into = (parent: string | null, before: ReturnType<typeof drawing> | null = null) => ({
    pane: null,
    below: false,
    parent,
    before,
  });

  it('puts a drawing into a group just behind one of its items', () => {
    expect(shape(moveItems(list, [drawing('a')], into('g1', drawing('d'))))).toEqual([
      '↓u',
      'b(g1)',
      'c(g1/g2)',
      'a(g1)',
      'd(g1)',
      'e',
      'r',
    ]);
  });

  it('puts one onto a group’s header first in it, and at its front with nothing to go behind', () => {
    // A drop onto the header: just behind its first item, the back of the group.
    expect(shape(moveItems(list, [drawing('e')], into('g1', drawing('b'))))).toEqual([
      '↓u',
      'a',
      'e(g1)',
      'b(g1)',
      'c(g1/g2)',
      'd(g1)',
      'r',
    ]);
    expect(shape(moveItems(list, [drawing('a')], into('g2')))).toEqual([
      '↓u',
      'b(g1)',
      'c(g1/g2)',
      'a(g1/g2)',
      'd(g1)',
      'e',
      'r',
    ]);
  });

  it('takes drawings out of their group, an emptied group going with them', () => {
    expect(shape(moveItems(list, [drawing('c')], into(null)))).toEqual([
      '↓u',
      'a',
      'b(g1)',
      'd(g1)',
      'e',
      'r',
      'c',
    ]);
  });

  it('moves a group with what’s inside it into another place or group', () => {
    expect(shape(moveItems(list, [group('g2')], into(null, drawing('a'))))).toEqual([
      '↓u',
      'c(g2)',
      'a',
      'b(g1)',
      'd(g1)',
      'e',
      'r',
    ]);
    const two = [...list.slice(0, 6), inGroups(make('f'), g('g3')), list[6] as Drawing];
    expect(shape(moveItems(two, [group('g3')], into('g1', drawing('b'))))).toEqual([
      '↓u',
      'a',
      'f(g1/g3)',
      'b(g1)',
      'c(g1/g2)',
      'd(g1)',
      'e',
      'r',
    ]);
  });

  it('takes a group’s layer when going into it', () => {
    const under = [inGroups(make('b', null, true), g('g1')), make('a')];
    expect(shape(moveItems(under, [drawing('a')], into('g1')))).toEqual(['↓b(g1)', '↓a(g1)']);
  });

  it('never drops a group into itself or one inside it, nor moves what isn’t on the pane', () => {
    expect(moveItems(list, [group('g1')], into('g2'))).toBe(list);
    expect(moveItems(list, [group('g1')], into('g1'))).toBe(list);
    expect(moveItems(list, [drawing('r')], into(null))).toBe(list);
    expect(moveItems(list, [drawing('b')], into('g1', drawing('b')))).toBe(list);
    expect(moveItems(list, [group('g1')], into(null, drawing('c')))).toBe(list);
  });

  it('gives the same list back when a drop leaves things where they were', () => {
    expect(moveItems(list, [drawing('b')], into('g1', group('g2') as never))).toBe(list);
    expect(moveItems(list, [drawing('e')], into(null, drawing('r')))).toBe(list);
  });
});
