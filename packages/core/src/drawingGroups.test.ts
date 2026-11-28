import { describe, expect, it } from 'vitest';
import {
  createGroup,
  groupMembers,
  groupPath,
  groupState,
  itemLevels,
  joinPath,
  nextGroupName,
  normalizeGroups,
  parentOf,
  placeNewDrawings,
  renameGroup,
  sameParent,
  topItems,
} from './drawingGroups.ts';
import { type Drawing, type DrawingGroup, newDrawing, parseDrawing } from './drawings.ts';

const g = (id: string, name = id.toUpperCase()): DrawingGroup => ({ id, name });

/** A drawing in some groups (outermost first), on a pane, under the bars or not. */
const make = (
  id: string,
  groups: DrawingGroup[] = [],
  pane: string | null = null,
  below = false,
): Drawing => ({
  ...newDrawing(
    id,
    'ray',
    [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ],
    pane,
  ),
  groups,
  below,
});

/** Each drawing as "id" or "id(A/B)" with its groups' ids, in list order. */
const shape = (drawings: readonly Drawing[]) =>
  drawings.map((d) => (d.groups.length ? `${d.id}(${d.groups.map((x) => x.id).join('/')})` : d.id));

const drawing = (ids: string[]) => ids.map((id) => ({ kind: 'drawing' as const, id }));
const group = (id: string) => ({ kind: 'group' as const, id });

describe('a drawing’s groups as stored (protocol 18)', () => {
  it('reads them, the outermost first, and none from an older file', () => {
    const stored = { ...make('a'), groups: [g('a1', ' Levels '), g('b1', 'Trend  lines')] };
    expect(parseDrawing(JSON.parse(JSON.stringify(stored)))?.groups).toEqual([
      { id: 'a1', name: 'Levels' },
      { id: 'b1', name: 'Trend lines' },
    ]);
    const { groups: _, ...older } = make('a');
    expect(parseDrawing(older)?.groups).toEqual([]);
  });

  it('keeps the drawing but drops groups that aren’t a list of them', () => {
    for (const groups of [
      'x',
      [{ id: 'bad id!', name: 'A' }],
      [g('a'), g('a')],
      [{ name: 'no id' }],
      Array.from({ length: 33 }, (_, i) => g(`x${i}`)),
    ]) {
      const parsed = parseDrawing({ ...make('a'), groups });
      expect(parsed?.id).toBe('a');
      expect(parsed?.groups).toEqual([]);
    }
  });
});

describe('the group rules (normalizeGroups)', () => {
  it('gives the same list back when they hold, or there are no groups', () => {
    const plain = [make('a'), make('b')];
    expect(normalizeGroups(plain)).toBe(plain);
    const kept = [make('x'), make('a', [g('a1')]), make('b', [g('a1')]), make('y')];
    expect(normalizeGroups(kept)).toBe(kept);
  });

  it('brings a group’s drawings together where its frontmost one is, the rest keeping order', () => {
    const list = [make('a', [g('a1')]), make('x'), make('b', [g('a1')]), make('y')];
    expect(shape(normalizeGroups(list))).toEqual(['x', 'a(a1)', 'b(a1)', 'y']);
  });

  it('keeps nested groups together inside theirs', () => {
    const list = [
      make('a', [g('a1'), g('b1')]),
      make('x'),
      make('b', [g('a1')]),
      make('c', [g('a1'), g('b1')]),
    ];
    expect(shape(normalizeGroups(list))).toEqual(['x', 'b(a1)', 'a(a1/b1)', 'c(a1/b1)']);
  });

  it('places and names a group as the first drawing naming it has it', () => {
    const list = [make('a', [g('a1', 'Outer'), g('b1', 'Inner')]), make('b', [g('b1', 'Other')])];
    const normal = normalizeGroups(list);
    expect(shape(normal)).toEqual(['a(a1/b1)', 'b(a1/b1)']);
    expect(normal[1]?.groups.map((x) => x.name)).toEqual(['Outer', 'Inner']);
  });

  it('takes a group’s layer from its frontmost drawing and leaves out one on another pane', () => {
    const list = [
      make('a', [g('a1')], null, true),
      make('r', [g('a1')], 'rsi-1'),
      make('b', [g('a1')], null, false),
    ];
    const normal = normalizeGroups(list);
    expect(shape(normal)).toEqual(['r', 'a(a1)', 'b(a1)']);
    expect(normal.map((d) => d.below)).toEqual([false, false, false]);
  });
});

describe('making a group (Create a group of drawings)', () => {
  const group1 = g('n1', 'Group 1');

  it('groups drawings side by side where they are, keeping their order', () => {
    const list = [make('x'), make('a'), make('b'), make('y')];
    const made = createGroup(list, drawing(['b', 'a']), group1);
    expect(shape(made ?? [])).toEqual(['x', 'a(n1)', 'b(n1)', 'y']);
    expect(made?.[1]?.groups).toEqual([group1]);
  });

  it('brings drawings apart to the frontmost one, as TradingView’s old docs say', () => {
    const list = [make('a'), make('x'), make('b'), make('y')];
    expect(shape(createGroup(list, drawing(['a', 'b']), group1) ?? [])).toEqual([
      'x',
      'a(n1)',
      'b(n1)',
      'y',
    ]);
  });

  it('puts a picked group inside the new one, and makes it inside the frontmost item’s group', () => {
    const list = [make('a', [g('a1')]), make('b', [g('a1')]), make('c', [g('p1')])];
    expect(shape(createGroup(list, [group('a1'), ...drawing(['c'])], group1) ?? [])).toEqual([
      'a(p1/n1/a1)',
      'b(p1/n1/a1)',
      'c(p1/n1)',
    ]);
  });

  it('takes no drawing twice when a picked group holds a picked drawing', () => {
    const list = [make('a', [g('a1')]), make('b', [g('a1')])];
    expect(shape(createGroup(list, [group('a1'), ...drawing(['a'])], group1) ?? [])).toEqual([
      'a(n1/a1)',
      'b(n1/a1)',
    ]);
  });

  it('refuses drawings of two panes, and nothing', () => {
    const list = [make('a'), make('r', [], 'rsi-1')];
    expect(createGroup(list, drawing(['a', 'r']), group1)).toBeNull();
    expect(createGroup(list, drawing(['gone']), group1)).toBeNull();
  });

  it('names a new group one more than the highest "Group N"', () => {
    expect(nextGroupName([make('a')])).toBe('Group 1');
    expect(
      nextGroupName([make('a', [g('a1', 'Group 3')]), make('b', [g('b1', 'Group 1')]), make('c')]),
    ).toBe('Group 4');
    expect(nextGroupName([make('a', [g('a1', 'Levels 7')])])).toBe('Group 1');
  });
});

describe('a group’s name, state and drawings', () => {
  const list = [
    { ...make('a', [g('a1', 'Group 1')]), hidden: true },
    { ...make('b', [g('a1', 'Group 1'), g('b1', 'Group 2')]), locked: true },
    make('c'),
  ];

  it('renames it on each of its drawings, an empty name leaving it', () => {
    const renamed = renameGroup(list, 'a1', '  Weekly  analysis ');
    expect(renamed.slice(0, 2).map((d) => d.groups[0]?.name)).toEqual([
      'Weekly analysis',
      'Weekly analysis',
    ]);
    expect(renamed[2]).toBe(list[2]);
    expect(renameGroup(list, 'a1', '   ')).toBe(list);
    expect(renameGroup(list, 'a1', 'Group 1')).toBe(list);
  });

  it('finds its drawings, path and parent', () => {
    expect(groupMembers(list, 'a1').map((d) => d.id)).toEqual(['a', 'b']);
    expect(groupPath(list, 'b1')?.map((x) => x.id)).toEqual(['a1', 'b1']);
    expect(groupPath(list, 'gone')).toBeNull();
    expect(parentOf(list, group('b1'))).toBe('a1');
    expect(parentOf(list, group('a1'))).toBeNull();
    expect(parentOf(list, { kind: 'drawing', id: 'b' })).toBe('b1');
  });

  it('is partly hidden and partly locked when its drawings differ', () => {
    expect(groupState(groupMembers(list, 'a1'))).toEqual({
      visibility: 'partial',
      lock: 'partial',
    });
    expect(groupState([list[1] as Drawing])).toEqual({ visibility: 'visible', lock: 'locked' });
    expect(groupState([list[0] as Drawing])).toEqual({ visibility: 'invisible', lock: 'unlocked' });
  });

  it('stands a picked group for the drawings in it', () => {
    expect(topItems(list, [...drawing(['b', 'c']), group('a1')])).toEqual([
      group('a1'),
      { kind: 'drawing', id: 'c' },
    ]);
    expect([...itemLevels(list, [group('b1'), ...drawing(['c'])])]).toEqual([
      ['b', 1],
      ['c', 0],
    ]);
    expect(sameParent(list, drawing(['a', 'c']))).toBe(false);
    expect(sameParent(list, [group('a1'), ...drawing(['c'])])).toBe(true);
  });
});

describe('new drawings and groups', () => {
  const list = [make('a', [g('a1')]), make('b', [g('a1')]), make('x')];

  it('joins the group picked, or the one the picked drawings are all in', () => {
    expect(joinPath(list, [group('a1')]).map((x) => x.id)).toEqual(['a1']);
    expect(joinPath(list, drawing(['a', 'b'])).map((x) => x.id)).toEqual(['a1']);
    expect(joinPath(list, drawing(['a', 'x']))).toEqual([]);
    expect(joinPath(list, drawing(['x']))).toEqual([]);
    expect(joinPath(list, [])).toEqual([]);
  });

  it('puts a clone at its group’s front, the group keeping its place (v33)', () => {
    const cloned = [...list, { ...make('c'), groups: [g('a1')] }];
    expect(shape(placeNewDrawings(list, cloned))).toEqual(['a(a1)', 'b(a1)', 'c(a1)', 'x']);
  });

  it('leaves a new drawing without a group at the front, and one of another pane out of it', () => {
    const drawn = [...list, make('n')];
    expect(placeNewDrawings(list, drawn)).toBe(drawn);
    const other = [...list, make('r', [g('a1')], 'rsi-1')];
    expect(shape(placeNewDrawings(list, other))).toEqual(['a(a1)', 'b(a1)', 'x', 'r']);
  });

  it('takes the group’s layer and names', () => {
    const under = [make('a', [g('a1', 'Levels')], null, true), make('x')];
    const placed = placeNewDrawings(under, [...under, make('c', [g('a1', 'old')])]);
    expect(placed[1]).toMatchObject({ id: 'c', below: true, groups: [g('a1', 'Levels')] });
  });
});
