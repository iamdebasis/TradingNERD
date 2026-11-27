import { type Drawing, newDrawing } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { dropPlace, type TreeIndicator, treeRows, treeSymbolLabel } from './objectTreeModel';

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

  it('goes just behind the drawing under the gap, taking its layer', () => {
    expect(dropPlace(rows, 3, null)).toEqual({ pane: null, below: false, before: 'a' });
    expect(dropPlace(rows, 0, null)).toEqual({ pane: null, below: true, before: 'u' });
  });

  it('goes to the front of a layer after its last drawing, or by the series when it’s empty', () => {
    expect(dropPlace(rows, 5, null)).toEqual({ pane: null, below: false, before: null });
    expect(dropPlace(rows, 1, null)).toEqual({ pane: null, below: true, before: null });
    const bare = treeRows([], [], 'X');
    expect(dropPlace(bare, 0, null)).toEqual({ pane: null, below: true, before: null });
    expect(dropPlace(bare, 1, null)).toEqual({ pane: null, below: false, before: null });
  });

  it('can’t go between two series rows, or among another pane’s rows', () => {
    expect(dropPlace(rows, 2, null)).toBeNull();
    expect(dropPlace(rows, 7, null)).toBeNull();
    expect(dropPlace(rows, 6, 'rsi-1')).toEqual({ pane: 'rsi-1', below: false, before: 'r' });
    expect(dropPlace(rows, 7, 'rsi-1')).toEqual({ pane: 'rsi-1', below: false, before: null });
    expect(dropPlace(rows, 5, 'rsi-1')).toEqual({ pane: 'rsi-1', below: true, before: null });
    expect(dropPlace(rows, 3, 'rsi-1')).toBeNull();
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
