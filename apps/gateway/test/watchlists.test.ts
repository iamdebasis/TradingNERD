import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_WATCHLIST, MAX_WATCHLISTS } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { WatchlistsStore } from '../src/storage/WatchlistsStore.ts';

const dir = () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'tn-watchlists-')), 'data');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
};

const MINE = {
  sections: [
    { id: 'crypto', title: 'Crypto', collapsed: true, symbols: [] },
    { id: 'mag7', title: 'MAG 7', collapsed: false, symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
  ],
};

describe('the watchlists store', () => {
  it('starts from the one list kept before, as "Watchlist", leaving its file as it was', async () => {
    const dataDir = dir();
    const before = JSON.stringify(MINE);
    writeFileSync(join(dataDir, 'watchlist.json'), before);
    const store = new WatchlistsStore(dataDir);
    expect(await store.index()).toEqual({
      activeId: 'watchlist',
      lists: [{ id: 'watchlist', name: 'Watchlist', favorite: false, count: 2 }],
    });
    expect(await store.get('watchlist')).toEqual({
      id: 'watchlist',
      name: 'Watchlist',
      favorite: false,
      ...MINE,
    });
    expect(readFileSync(join(dataDir, 'watchlist.json'), 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(join(dataDir, 'watchlists.json'), 'utf8'))).toMatchObject({
      version: 1,
      activeId: 'watchlist',
    });
  });

  it('starts from the default list without one', async () => {
    const store = new WatchlistsStore(dir());
    expect(await store.active()).toEqual(DEFAULT_WATCHLIST);
  });

  it('creates lists, copies and uploads, each with a name of its own, and opens them', async () => {
    const store = new WatchlistsStore(dir());
    const empty = await store.create({ name: 'Watchlist' });
    expect(empty).toMatchObject({ name: 'Watchlist (1)', count: 0, favorite: false });
    expect((await store.index()).activeId).toBe(empty.id);

    const copy = await store.create({ name: 'Watchlist', copyOf: 'watchlist' });
    expect(copy).toMatchObject({
      name: 'Watchlist (2)',
      count: DEFAULT_WATCHLIST.sections[0]?.symbols.length,
    });

    const uploaded = await store.create({
      name: 'From TradingView',
      sections: [
        { id: 's1', title: 'CRYPTO ETFS', collapsed: false, symbols: ['amex:gbtc', 'OTC:LTCN'] },
        {
          id: 's2',
          title: 'MARKET CAP',
          collapsed: false,
          symbols: ['CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD'],
        },
      ],
      activate: false,
    });
    expect((await store.index()).activeId).toBe(copy.id);
    expect((await store.get(uploaded.id)).sections.flatMap((s) => s.symbols)).toEqual([
      'AMEX:GBTC',
      'OTC:LTCN',
      'CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD',
    ]);
  });

  it('renames and stars a list', async () => {
    const store = new WatchlistsStore(dir());
    expect(await store.update('watchlist', { name: '  Crypto  ', favorite: true })).toMatchObject({
      name: 'Crypto',
      favorite: true,
    });
    await expect(store.update('watchlist', { name: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(store.update('nope', { favorite: true })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('opens a list, and saves each list on its own', async () => {
    const store = new WatchlistsStore(dir());
    const second = await store.create({ name: 'w2', activate: false });
    await store.activate(second.id);
    expect((await store.index()).activeId).toBe(second.id);
    await Promise.all([
      store.save('watchlist', MINE),
      store.save(second.id, {
        sections: [{ id: 'a', title: '', collapsed: false, symbols: ['NYSE:IBM'] }],
      }),
    ]);
    expect((await store.get('watchlist')).sections).toEqual(MINE.sections);
    expect((await store.active()).sections[0]?.symbols).toEqual(['NYSE:IBM']);
    await expect(store.save('watchlist', { sections: [{ nope: true }] })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('deletes a list, the open one handing over to the first; the last one stays', async () => {
    const store = new WatchlistsStore(dir());
    const second = await store.create({ name: 'w2' });
    const index = await store.remove(second.id);
    expect(index).toMatchObject({ activeId: 'watchlist', lists: [{ id: 'watchlist' }] });
    await expect(store.remove('watchlist')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(store.remove(second.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it(`stops at ${MAX_WATCHLISTS} lists`, async () => {
    const dataDir = dir();
    const lists = Array.from({ length: MAX_WATCHLISTS }, (_, i) => ({
      id: `l-${i}`,
      name: `List ${i}`,
      favorite: false,
      sections: [],
    }));
    writeFileSync(
      join(dataDir, 'watchlists.json'),
      JSON.stringify({ version: 1, activeId: 'l-0', lists }),
    );
    const store = new WatchlistsStore(dataDir);
    await expect(store.create({ name: 'One more' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});
