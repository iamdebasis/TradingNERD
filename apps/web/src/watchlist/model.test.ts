import type { Watchlist } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  addSymbol,
  allSymbols,
  moveSymbol,
  neighbor,
  removeSymbol,
  toggleSection,
  visibleSymbols,
} from './model';

const LIST: Watchlist = {
  sections: [
    { id: 'a', title: 'Crypto', collapsed: false, symbols: ['X:A', 'X:B', 'X:C'] },
    { id: 'b', title: 'More', collapsed: false, symbols: ['X:D', 'X:E'] },
  ],
};

describe('watchlist edits', () => {
  it('removes a symbol, and leaves the list alone for one it lacks', () => {
    expect(allSymbols(removeSymbol(LIST, 'X:B'))).toEqual(['X:A', 'X:C', 'X:D', 'X:E']);
    expect(removeSymbol(LIST, 'X:Z')).toBe(LIST);
  });

  it("adds a symbol once, at the end of the selected row's section, else the last", () => {
    expect(addSymbol(LIST, 'X:F', 'X:A').sections.map((s) => s.symbols)).toEqual([
      ['X:A', 'X:B', 'X:C', 'X:F'],
      ['X:D', 'X:E'],
    ]);
    expect(addSymbol(LIST, 'X:F', null).sections[1]?.symbols).toEqual(['X:D', 'X:E', 'X:F']);
    expect(addSymbol(LIST, 'X:F', 'X:GONE').sections[1]?.symbols.at(-1)).toBe('X:F');
    expect(addSymbol(LIST, 'X:B', null)).toBe(LIST);
    expect(addSymbol({ sections: [] }, 'X:A', null)).toEqual({
      sections: [{ id: 'crypto', title: 'Crypto', collapsed: false, symbols: ['X:A'] }],
    });
  });

  it('moves a symbol within a section and across sections', () => {
    expect(moveSymbol(LIST, 'X:A', 'a', 2).sections[0]?.symbols).toEqual(['X:B', 'X:C', 'X:A']);
    expect(moveSymbol(LIST, 'X:C', 'a', 0).sections[0]?.symbols).toEqual(['X:C', 'X:A', 'X:B']);
    const across = moveSymbol(LIST, 'X:B', 'b', 1);
    expect(across.sections.map((s) => s.symbols)).toEqual([
      ['X:A', 'X:C'],
      ['X:D', 'X:B', 'X:E'],
    ]);
    expect(moveSymbol(LIST, 'X:Z', 'a', 0)).toBe(LIST);
  });

  it('folds sections, hiding their symbols from the keyboard', () => {
    const folded = toggleSection(LIST, 'a');
    expect(folded.sections[0]?.collapsed).toBe(true);
    expect(visibleSymbols(folded)).toEqual(['X:D', 'X:E']);
    expect(allSymbols(folded)).toHaveLength(5);
  });

  it('steps up and down through visible symbols, staying at the ends', () => {
    expect(neighbor(LIST, 'X:C', 1)).toBe('X:D');
    expect(neighbor(LIST, 'X:A', -1)).toBe('X:A');
    expect(neighbor(LIST, 'X:E', 1)).toBe('X:E');
    expect(neighbor(LIST, null, 1)).toBe('X:A');
    expect(neighbor(LIST, 'X:Z', -1)).toBe('X:E');
    expect(neighbor(toggleSection(LIST, 'b'), 'X:C', 1)).toBe('X:C');
  });
});
