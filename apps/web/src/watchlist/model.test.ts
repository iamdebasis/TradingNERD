import type { Watchlist } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  addSection,
  addSymbol,
  allSymbols,
  dropLine,
  insertSymbol,
  moveSection,
  moveSectionHeader,
  moveSymbol,
  neighbor,
  nextItem,
  removeSection,
  removeSymbol,
  renameSection,
  toggleSection,
  visibleItems,
  visibleSymbols,
} from './model';

const LIST: Watchlist = {
  sections: [
    { id: 'a', title: 'Crypto', collapsed: false, symbols: ['X:A', 'X:B', 'X:C'] },
    { id: 'b', title: 'More', collapsed: false, symbols: ['X:D', 'X:E'] },
  ],
};
const ABC: Watchlist = {
  sections: [
    { id: 'a', title: 'A', collapsed: false, symbols: ['X:A1', 'X:A2'] },
    { id: 'b', title: 'B', collapsed: false, symbols: ['X:B1', 'X:B2'] },
    { id: 'c', title: 'C', collapsed: false, symbols: ['X:C1'] },
  ],
};
/** Symbols with no header above the first section, as an uploaded TradingView file can have. */
const TOP: Watchlist = {
  sections: [
    { id: 't', title: '', collapsed: false, symbols: ['X:T1', 'X:T2'] },
    { id: 'a', title: 'A', collapsed: false, symbols: ['X:A1'] },
    { id: 'b', title: 'B', collapsed: false, symbols: ['X:B1'] },
  ],
};
const shape = (list: Watchlist) =>
  list.sections.map((s) => [s.id, s.title, s.collapsed, s.symbols]);

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

  it('hands its symbols, in order, to the end of the section above', () => {
    const list = removeSection(THREE, 'c');
    expect(shape(list)).toEqual([
      ['a', 'Crypto', false, ['X:A', 'X:B']],
      ['b', 'More', false, ['X:C', 'X:D', 'X:E']], // opened, so they stay in sight
    ]);
    expect(allSymbols(list)).toEqual(allSymbols(THREE));
  });

  it("can't delete a folded section, as on TradingView", () => {
    expect(removeSection(THREE, 'b')).toBe(THREE);
  });

  it("keeps the first section's symbols at the top, with no header", () => {
    const list = removeSection(THREE, 'a');
    expect(shape(list)).toEqual([
      ['a', '', false, ['X:A', 'X:B']],
      ['b', 'More', true, ['X:C', 'X:D']],
      ['c', 'Last', false, ['X:E']],
    ]);
    // A section without a header has none to delete.
    expect(removeSection(list, 'a')).toBe(list);
    // The next first section joins them, once open.
    expect(shape(removeSection(toggleSection(list, 'b'), 'b'))).toEqual([
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
      sections: [{ id: 'a', title: 'Crypto', collapsed: false, symbols: ['X:A', 'X:B'] }],
    };
    expect(shape(removeSection(one, 'a'))).toEqual([['a', '', false, ['X:A', 'X:B']]]);
    expect(removeSection(LIST, 'nope')).toBe(LIST);
  });
});

describe("moving an open section's header: it moves alone, as TradingView's divider", () => {
  it('up into the section above: the rows stay put and the boundary moves', () => {
    const list = moveSectionHeader(ABC, 'b', { symbol: 'X:A2' });
    expect(shape(list)).toEqual([
      ['a', 'A', false, ['X:A1']],
      ['b', 'B', false, ['X:A2', 'X:B1', 'X:B2']],
      ['c', 'C', false, ['X:C1']],
    ]);
    expect(allSymbols(list)).toEqual(allSymbols(ABC));
  });

  it('down into the next section: the rows it leaves join the section above', () => {
    expect(shape(moveSectionHeader(ABC, 'b', { symbol: 'X:C1' }))).toEqual([
      ['a', 'A', false, ['X:A1', 'X:A2', 'X:B1', 'X:B2']],
      ['c', 'C', false, []],
      ['b', 'B', false, ['X:C1']],
    ]);
  });

  it('to the end, and above another header', () => {
    expect(shape(moveSectionHeader(ABC, 'b', null))).toEqual([
      ['a', 'A', false, ['X:A1', 'X:A2', 'X:B1', 'X:B2']],
      ['c', 'C', false, ['X:C1']],
      ['b', 'B', false, []],
    ]);
    expect(shape(moveSectionHeader(ABC, 'b', { section: 'a' }))).toEqual([
      ['b', 'B', false, []],
      ['a', 'A', false, ['X:A1', 'X:A2', 'X:B1', 'X:B2']],
      ['c', 'C', false, ['X:C1']],
    ]);
  });

  it('changes nothing dropped where it is: above itself or above its own first row', () => {
    expect(moveSectionHeader(ABC, 'b', { section: 'b' })).toBe(ABC);
    expect(moveSectionHeader(ABC, 'b', { symbol: 'X:B1' })).toBe(ABC);
  });

  it('from the first section, leaves its symbols at the top with no header', () => {
    expect(shape(moveSectionHeader(ABC, 'a', { symbol: 'X:B2' }))).toEqual([
      ['top', '', false, ['X:A1', 'X:A2']],
      ['b', 'B', false, ['X:B1']],
      ['a', 'A', false, ['X:B2']],
      ['c', 'C', false, ['X:C1']],
    ]);
  });

  it('into the symbols with no header, which keep their id; above them all, it takes them in', () => {
    expect(shape(moveSectionHeader(TOP, 'a', { symbol: 'X:T2' }))).toEqual([
      ['t', '', false, ['X:T1']],
      ['a', 'A', false, ['X:T2', 'X:A1']],
      ['b', 'B', false, ['X:B1']],
    ]);
    expect(shape(moveSectionHeader(TOP, 'b', { symbol: 'X:T1' }))).toEqual([
      ['b', 'B', false, ['X:T1', 'X:T2']],
      ['a', 'A', false, ['X:A1', 'X:B1']],
    ]);
  });

  it('opens a folded section above for the rows it takes, keeping the others as they were', () => {
    const folded = toggleSection(toggleSection(ABC, 'a'), 'c');
    expect(shape(moveSectionHeader(folded, 'b', { section: 'c' }))).toEqual([
      ['a', 'A', false, ['X:A1', 'X:A2', 'X:B1', 'X:B2']],
      ['b', 'B', false, []],
      ['c', 'C', true, ['X:C1']],
    ]);
  });

  it("refuses a folded or headerless section, a row hidden in a folded one, and what isn't there", () => {
    const folded = toggleSection(ABC, 'b');
    expect(moveSectionHeader(folded, 'b', null)).toBe(folded);
    expect(moveSectionHeader(TOP, 't', null)).toBe(TOP);
    expect(moveSectionHeader(folded, 'a', { symbol: 'X:B2' })).toBe(folded);
    expect(moveSectionHeader(ABC, 'nope', null)).toBe(ABC);
    expect(moveSectionHeader(ABC, 'b', { symbol: 'X:NOPE' })).toBe(ABC);
    expect(moveSectionHeader(ABC, 'b', { section: 'nope' })).toBe(ABC);
  });

  it('never takes a list past its 200 sections', () => {
    const full: Watchlist = {
      sections: Array.from({ length: 200 }, (_, i) => ({
        id: `s${i}`,
        title: `S${i}`,
        collapsed: false,
        symbols: [`X:S${i}`],
      })),
    };
    // The first header moving down would leave a 201st: its symbol, with no header.
    expect(moveSectionHeader(full, 's0', { symbol: 'X:S1' })).toBe(full);
    expect(moveSectionHeader(full, 's1', { symbol: 'X:S2' })).not.toBe(full);
  });
});

describe('moving a folded section: it moves whole, between sections only', () => {
  const folded = toggleSection(ABC, 'b');

  it('above another section, its symbols with it and still folded', () => {
    expect(shape(moveSection(folded, 'b', 'a'))).toEqual([
      ['b', 'B', true, ['X:B1', 'X:B2']],
      ['a', 'A', false, ['X:A1', 'X:A2']],
      ['c', 'C', false, ['X:C1']],
    ]);
  });

  it('to the end', () => {
    expect(shape(moveSection(folded, 'b', null))).toEqual([
      ['a', 'A', false, ['X:A1', 'X:A2']],
      ['c', 'C', false, ['X:C1']],
      ['b', 'B', true, ['X:B1', 'X:B2']],
    ]);
  });

  it('changes nothing dropped where it is: above itself or above the next section', () => {
    expect(moveSection(folded, 'b', 'b')).toBe(folded);
    expect(moveSection(folded, 'b', 'c')).toBe(folded);
    expect(moveSection(folded, 'c', null)).toBe(folded);
  });

  it("never goes above the symbols with no header, and ignores what isn't there", () => {
    expect(moveSection(TOP, 'b', 't')).toBe(TOP);
    expect(shape(moveSection(TOP, 'b', 'a'))).toEqual([
      ['t', '', false, ['X:T1', 'X:T2']],
      ['b', 'B', false, ['X:B1']],
      ['a', 'A', false, ['X:A1']],
    ]);
    expect(moveSection(TOP, 't', null)).toBe(TOP);
    expect(moveSection(ABC, 'nope', null)).toBe(ABC);
    expect(moveSection(ABC, 'a', 'nope')).toBe(ABC);
  });
});

describe('the rows shown, and where a drop draws its line', () => {
  const list: Watchlist = {
    sections: [
      { id: 't', title: '', collapsed: false, symbols: ['X:T1', 'X:T2'] },
      { id: 'a', title: 'A', collapsed: false, symbols: ['X:A1', 'X:A2'] },
      { id: 'b', title: 'B', collapsed: true, symbols: ['X:B1', 'X:B2'] },
      { id: 'c', title: 'C', collapsed: false, symbols: ['X:C1'] },
    ],
  };

  it("lists the headers and the open sections' rows, top to bottom", () => {
    expect(visibleItems(list)).toEqual([
      { symbol: 'X:T1' },
      { symbol: 'X:T2' },
      { section: 'a' },
      { symbol: 'X:A1' },
      { symbol: 'X:A2' },
      { section: 'b' }, // folded: its rows hidden
      { section: 'c' },
      { symbol: 'X:C1' },
    ]);
    expect(nextItem(list, { symbol: 'X:A2' })).toEqual({ section: 'b' });
    expect(nextItem(list, { section: 'b' })).toEqual({ section: 'c' });
    expect(nextItem(list, { symbol: 'X:C1' })).toBeNull();
  });

  it('draws it on the line under the row above, or over the first row', () => {
    expect(dropLine(list, { section: 'b' })).toEqual({ item: { symbol: 'X:A2' }, edge: 'after' });
    expect(dropLine(list, { section: 'c' })).toEqual({ item: { section: 'b' }, edge: 'after' });
    expect(dropLine(list, null)).toEqual({ item: { symbol: 'X:C1' }, edge: 'after' });
    expect(dropLine(list, { symbol: 'X:T1' })).toEqual({
      item: { symbol: 'X:T1' },
      edge: 'before',
    });
    expect(dropLine(list, { symbol: 'X:B1' })).toBeNull(); // hidden in a folded section
    expect(dropLine({ sections: [] }, null)).toBeNull();
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
