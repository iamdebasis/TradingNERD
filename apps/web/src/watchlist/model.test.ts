import type { Watchlist } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  addSection,
  addSymbol,
  allSymbols,
  insertSymbol,
  moveSymbol,
  neighbor,
  removeSection,
  removeSymbol,
  renameSection,
  toggleSection,
  visibleSymbols,
} from './model';

const LIST: Watchlist = {
  sections: [
    { id: 'a', title: 'Crypto', collapsed: false, symbols: ['X:A', 'X:B', 'X:C'] },
    { id: 'b', title: 'More', collapsed: false, symbols: ['X:D', 'X:E'] },
  ],
};

describe('adding at a row', () => {
  it("puts a symbol right after the row, as a row menu's Add symbol", () => {
    const list = insertSymbol(LIST, 'X:F', 'X:B');
    expect(list.sections[0]?.symbols).toEqual(['X:A', 'X:B', 'X:F', 'X:C']);
    expect(insertSymbol(list, 'X:F', 'X:A')).toBe(list); // already listed
    expect(insertSymbol(LIST, 'X:F', 'X:NOPE').sections[1]?.symbols).toEqual(['X:D', 'X:E', 'X:F']);
  });

  it('starts a section above a row, taking it and the rows after it', () => {
    const { list, id } = addSection(LIST, 'X:B');
    expect(list.sections.map((s) => [s.id, s.title, s.symbols])).toEqual([
      ['a', 'Crypto', ['X:A']],
      ['section-1', 'Section 1', ['X:B', 'X:C']],
      ['b', 'More', ['X:D', 'X:E']],
    ]);
    expect(id).toBe('section-1');
    const again = addSection(list, 'X:E');
    expect(again.id).toBe('section-2');
    expect(again.list.sections.map((s) => s.symbols)).toEqual([
      ['X:A'],
      ['X:B', 'X:C'],
      ['X:D'],
      ['X:E'],
    ]);
  });

  it('renames a section, keeping the old name for an empty one', () => {
    const renamed = renameSection(LIST, 'b', '  Alts  ');
    expect(renamed.sections[1]?.title).toBe('Alts');
    expect(renameSection(renamed, 'b', '   ')).toBe(renamed);
    expect(renameSection(renamed, 'nope', 'X')).toBe(renamed);
  });
});

describe('deleting a section, as TradingView: its symbols stay', () => {
  const THREE: Watchlist = {
    sections: [
      { id: 'a', title: 'Crypto', collapsed: false, symbols: ['X:A', 'X:B'] },
      { id: 'b', title: 'More', collapsed: true, symbols: ['X:C', 'X:D'] },
      { id: 'c', title: 'Last', collapsed: false, symbols: ['X:E'] },
    ],
  };
  const shape = (list: Watchlist) =>
    list.sections.map((s) => [s.id, s.title, s.collapsed, s.symbols]);

  it('hands its symbols, in order, to the end of the section above', () => {
    const list = removeSection(THREE, 'c');
    expect(shape(list)).toEqual([
      ['a', 'Crypto', false, ['X:A', 'X:B']],
      ['b', 'More', false, ['X:C', 'X:D', 'X:E']], // opened, so they stay in sight
    ]);
    expect(allSymbols(list)).toEqual(allSymbols(THREE));
  });

  it("from a folded section too: they're all kept", () => {
    expect(shape(removeSection(THREE, 'b'))).toEqual([
      ['a', 'Crypto', false, ['X:A', 'X:B', 'X:C', 'X:D']],
      ['c', 'Last', false, ['X:E']],
    ]);
  });

  it("keeps the first section's symbols at the top, with no header", () => {
    const list = removeSection(toggleSection(THREE, 'a'), 'a');
    expect(shape(list)).toEqual([
      ['a', '', false, ['X:A', 'X:B']], // unfolded: nothing could open it again
      ['b', 'More', true, ['X:C', 'X:D']],
      ['c', 'Last', false, ['X:E']],
    ]);
    // A section without a header has none to delete.
    expect(removeSection(list, 'a')).toBe(list);
    // The next first section joins them.
    expect(shape(removeSection(list, 'b'))).toEqual([
      ['a', '', false, ['X:A', 'X:B', 'X:C', 'X:D']],
      ['c', 'Last', false, ['X:E']],
    ]);
  });

  it('joins symbols already headerless below the first section, keeping one such group', () => {
    const above: Watchlist = {
      sections: [
        { id: 'new', title: 'New', collapsed: false, symbols: ['X:A'] },
        { id: 'top', title: '', collapsed: false, symbols: ['X:B', 'X:C'] },
        { id: 'b', title: 'More', collapsed: false, symbols: ['X:D'] },
      ],
    };
    expect(shape(removeSection(above, 'new'))).toEqual([
      ['new', '', false, ['X:A', 'X:B', 'X:C']],
      ['b', 'More', false, ['X:D']],
    ]);
  });

  it('takes an empty section away, leaving the others as they were', () => {
    const empty: Watchlist = {
      sections: [
        { id: 'a', title: 'Crypto', collapsed: true, symbols: ['X:A'] },
        { id: 'e', title: 'Empty', collapsed: false, symbols: [] },
        { id: 'b', title: 'More', collapsed: false, symbols: ['X:B'] },
      ],
    };
    expect(shape(removeSection(empty, 'e'))).toEqual([
      ['a', 'Crypto', true, ['X:A']], // nothing joined it, so it stays folded
      ['b', 'More', false, ['X:B']],
    ]);
    const alone: Watchlist = {
      sections: [{ id: 'e', title: 'Empty', collapsed: false, symbols: [] }],
    };
    expect(removeSection(alone, 'e')).toEqual({ sections: [] });
  });

  it("keeps the only section's symbols with no header, and ignores an unknown id", () => {
    const one: Watchlist = {
      sections: [{ id: 'a', title: 'Crypto', collapsed: true, symbols: ['X:A', 'X:B'] }],
    };
    expect(shape(removeSection(one, 'a'))).toEqual([['a', '', false, ['X:A', 'X:B']]]);
    expect(removeSection(LIST, 'nope')).toBe(LIST);
  });
});

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
