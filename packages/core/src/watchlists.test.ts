import { describe, expect, it } from 'vitest';
import {
  parseNamedWatchlist,
  parseWatchlistName,
  parseWatchlistsIndex,
  sortedLists,
  uniqueListName,
} from './watchlists.ts';

describe('several watchlists', () => {
  it('name a copy or an upload with the first free " (n)"', () => {
    expect(uniqueListName('Watchlist', ['w2'])).toBe('Watchlist');
    expect(uniqueListName('Watchlist', ['Watchlist', 'watchlist (1)'])).toBe('Watchlist (2)');
    expect(uniqueListName('  ', [])).toBe('Watchlist');
    expect(uniqueListName('x'.repeat(64), ['x'.repeat(64)])).toBe(`${'x'.repeat(60)} (1)`);
  });

  it('list starred ones first, then by name', () => {
    const lists = [
      { id: 'b', name: 'w2', favorite: false },
      { id: 'c', name: 'Watchlist (1)', favorite: false },
      { id: 'a', name: 'Watchlist', favorite: true },
      { id: 'd', name: 'w10', favorite: false },
    ];
    expect(sortedLists(lists).map((list) => list.name)).toEqual([
      'Watchlist',
      'w2',
      'w10',
      'Watchlist (1)',
    ]);
  });

  it('check names, the list of lists and one list', () => {
    expect(parseWatchlistName('  Mag 7  ')).toBe('Mag 7');
    expect(parseWatchlistName('')).toBeNull();
    expect(parseWatchlistName('x'.repeat(65))).toBeNull();
    const index = {
      activeId: 'main',
      lists: [{ id: 'main', name: 'Watchlist', favorite: true, count: 48 }],
    };
    expect(parseWatchlistsIndex(index)).toEqual(index);
    expect(parseWatchlistsIndex({ ...index, activeId: 'gone' })).toBeNull();
    expect(parseWatchlistsIndex({ activeId: 'main', lists: [] })).toBeNull();
    const list = {
      id: 'main',
      name: 'Watchlist',
      favorite: false,
      sections: [{ id: 's1', title: '', collapsed: false, symbols: ['CRYPTOCAP:BTC.D'] }],
    };
    expect(parseNamedWatchlist(list)).toEqual(list);
    expect(parseNamedWatchlist({ ...list, id: 'Main!' })).toBeNull();
  });
});
