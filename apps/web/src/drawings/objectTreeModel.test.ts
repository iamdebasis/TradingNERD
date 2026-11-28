import { type Drawing, type DrawingGroup, newDrawing } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  type GroupRow,
  gapDrop,
  headerDrop,
  type TreeDrag,
  type TreeIndicator,
  treeRows,
  treeSymbolLabel,
} from './objectTreeModel';

const line = (id: string, pane: string | null = null, below = false): Drawing => ({
  ...newDrawing(id, 'trend-line', [
    { time: 1, price: 1 },
    { time: 2, price: 2 },
  ]),
  pane,
  below,
});

const indicators: TreeIndicator[] = [
  { id: 'volume-1', label: 'Vol', hidden: false, overlay: true },
  { id: 'rsi-1', label: 'RSI 14 close', hidden: true, overlay: false },
];

/** The rows as their keys, the drawings by id. */
const keys = (rows: ReturnType<typeof treeRows>) => rows.map((row) => row.key);

describe('the Object tree’s rows (D3c)', () => {
  const drawings = [
    line('a'),
    line('u', null, true),
    line('b'),
    line('r', 'rsi-1'),
    line('ru', 'rsi-1', true),
  ];
  const rows = treeRows(drawings, indicators, 'XRPUSDT · BINANCE, 1D');

  it('list each pane in paint order, its top row at the back, the price pane first', () => {
    expect(keys(rows)).toEqual([
      'd:u',
      'symbol',
      'i:volume-1',
      'd:a',
      'd:b',
      'd:ru',
      'i:rsi-1',
      'd:r',
    ]);
  });

  it('name a drawing by its name, else its tool’s, and keep an indicator’s hidden state', () => {
    const named = treeRows([{ ...line('a'), name: 'Neckline' }, line('b')], [], 'X');
    expect(named.map((row) => row.label)).toEqual(['X', 'Neckline', 'Trendline']);
    expect(rows.find((row) => row.key === 'i:rsi-1')).toMatchObject({
      hidden: true,
      pane: 'rsi-1',
    });
  });

  it('leave out drawings on the pane of an indicator not on the chart', () => {
    expect(keys(treeRows([line('x', 'macd-1')], [], 'X'))).toEqual(['symbol']);
  });
});

describe('where a drag in the Object tree drops (D3c)', () => {
  const drawings = [line('a'), line('u', null, true), line('b'), line('r', 'rsi-1')];
  // u↓ | symbol | volume | a | b || rsi-1 | r
  const rows = treeRows(drawings, indicators, 'X');
  const of = (pane: string | null): TreeDrag => ({ pane, items: new Set(), groups: new Set() });
  const place = (gap: number, pane: string | null, list = rows) => {
    const target = gapDrop(list, gap, 0, of(pane))?.target;
    return (
      target && { below: target.below, before: target.before?.id ?? null, parent: target.parent }
    );
  };

  it('goes just behind the drawing under the gap, taking its layer', () => {
    expect(place(3, null)).toEqual({ below: false, before: 'a', parent: null });
    expect(place(0, null)).toEqual({ below: true, before: 'u', parent: null });
  });

  it('goes to the front of a layer after its last drawing, or by the series when it’s empty', () => {
    expect(place(5, null)).toEqual({ below: false, before: null, parent: null });
    expect(place(1, null)).toEqual({ below: true, before: null, parent: null });
    const bare = treeRows([], [], 'X');
    expect(place(0, null, bare)).toEqual({ below: true, before: null, parent: null });
    expect(place(1, null, bare)).toEqual({ below: false, before: null, parent: null });
  });

  it('can’t go between two series rows, or among another pane’s rows', () => {
    expect(place(2, null)).toBeUndefined();
    expect(place(7, null)).toBeUndefined();
    expect(place(6, 'rsi-1')).toEqual({ below: false, before: 'r', parent: null });
    expect(place(7, 'rsi-1')).toEqual({ below: false, before: null, parent: null });
    expect(place(5, 'rsi-1')).toEqual({ below: true, before: null, parent: null });
    expect(place(3, 'rsi-1')).toBeUndefined();
  });
});

describe('the Object tree’s groups (D3c2)', () => {
  const g = (id: string, name = ''): DrawingGroup => ({ id, name });
  const inGroups = (drawing: Drawing, ...groups: DrawingGroup[]) => ({ ...drawing, groups });
  // a | Group 1 [ b | Group 2 [ c ] | d ] | e
  const drawings = [
    line('a'),
    inGroups(line('b'), g('g1', 'Group 1')),
    inGroups(line('c'), g('g1', 'Group 1'), g('g2', 'Group 2')),
    inGroups(line('d'), g('g1', 'Group 1')),
    line('e'),
  ];
  const rows = treeRows(drawings, [], 'X');
  const drag = (...keys: string[]): TreeDrag => ({
    pane: null,
    items: new Set(keys),
    groups: new Set(keys.filter((key) => key.startsWith('g:')).map((key) => key.slice(2))),
  });

  it('lists a group’s row before what’s in it, each level one deeper', () => {
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.label}`)).toEqual([
      'X',
      'Trendline',
      'Group 1',
      '  Trendline',
      '  Group 2',
      '    Trendline',
      '  Trendline',
      'Trendline',
    ]);
    expect(rows[2]).toMatchObject({ kind: 'group', id: 'g1', path: ['g1'], folded: false });
    expect((rows[2] as GroupRow).members.map((d) => d.id)).toEqual(['b', 'c', 'd']);
    expect(rows[4]).toMatchObject({ kind: 'group', path: ['g1', 'g2'] });
  });

  it('leaves out what’s in a folded group, its row staying', () => {
    expect(treeRows(drawings, [], 'X', new Set(['g1'])).map((row) => row.key)).toEqual([
      'symbol',
      'd:a',
      'g:g1',
      'd:e',
    ]);
    expect(treeRows(drawings, [], 'X', new Set(['g2'])).map((row) => row.key)).toContain('d:d');
  });

  it('drops into a group between its rows, behind the row under the gap', () => {
    expect(gapDrop(rows, 3, 0, drag('d:a'))?.target).toEqual({
      pane: null,
      below: false,
      parent: 'g1',
      before: { kind: 'drawing', id: 'b' },
    });
  });

  it('after a group’s last row, goes as deep as the pointer says: inside at its front, or out', () => {
    // The gap after d (the last of Group 1), before e.
    expect(gapDrop(rows, 7, 1, drag('d:a'))).toMatchObject({
      depth: 1,
      target: { parent: 'g1', before: null },
    });
    expect(gapDrop(rows, 7, 0, drag('d:a'))).toMatchObject({
      depth: 0,
      target: { parent: null, before: { kind: 'drawing', id: 'e' } },
    });
    // After c, the last of Group 2: inside it, at Group 1's level before d, never deeper.
    expect(gapDrop(rows, 6, 5, drag('d:a'))?.target).toMatchObject({ parent: 'g2', before: null });
    expect(gapDrop(rows, 6, 1, drag('d:a'))?.target).toMatchObject({
      parent: 'g1',
      before: { kind: 'drawing', id: 'd' },
    });
  });

  it('drops onto a group’s row first inside it, and never into what’s dragged', () => {
    const group1 = rows[2] as GroupRow;
    expect(headerDrop(group1, drag('d:e'))?.target).toEqual({
      pane: null,
      below: false,
      parent: 'g1',
      before: { kind: 'drawing', id: 'b' },
    });
    // b dragged onto its own group's row goes behind the next item, Group 2.
    expect(headerDrop(group1, drag('d:b'))?.target.before).toEqual({ kind: 'group', id: 'g2' });
    expect(headerDrop(group1, drag('g:g1'))).toBeNull();
    expect(headerDrop(rows[4] as GroupRow, drag('g:g1'))).toBeNull();
    expect(gapDrop(rows, 5, 2, drag('g:g1'))).toBeNull();
    expect(gapDrop(rows, 3, 1, drag('d:b'))).toBeNull();
  });
});

describe('the Object tree’s symbol row (D3c)', () => {
  it('names the ticker, its exchange and the interval, as TradingView’s', () => {
    expect(treeSymbolLabel('NASDAQ:AAPL', '1D')).toBe('AAPL · NASDAQ, 1D');
    expect(treeSymbolLabel('BINANCE:XRPUSDT', '60')).toBe('XRPUSDT · BINANCE, 1h');
    expect(treeSymbolLabel('BINANCE:XRPUSDT', '1')).toBe('XRPUSDT · BINANCE, 1');
  });

  it('names a formula without an exchange', () => {
    expect(treeSymbolLabel('BINANCE:BTCUSDT/BINANCE:ETHUSDT', '1D')).toBe('BTCUSDT/ETHUSDT, 1D');
  });
});
