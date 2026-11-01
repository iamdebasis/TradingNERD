import type { SavedScript } from '@tradingnerd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptsApi } from '../data/api';
import { NEW_LIBRARY, PineStore, RECENT_COUNT, RECENT_KEY, sanitizeRecent } from './pineStore';
import { matchingVersions } from './VersionHistoryDialog';

const RSI = '//@version=6\nindicator("My RSI")\nplot(ta.rsi(close, 14))\n';

/** The gateway's scripts, in memory, numbering ids as it does. */
function fakeApi(): ScriptsApi & { scripts: SavedScript[] } {
  const scripts: SavedScript[] = [];
  let next = 1;
  const saved = (id: string, name: string, source: string): SavedScript => ({
    id,
    name,
    from: null,
    version: 1,
    savedAt: 1_000,
    source,
    versions: [{ version: 1, savedAt: 1_000 }],
  });
  const find = (id: string) => {
    const script = scripts.find((item) => item.id === id);
    if (!script) throw new Error('There is no such script');
    return script;
  };
  return {
    scripts,
    index: async () => ({ scripts }),
    get: async (id) => find(id),
    version: async (id) => ({ version: 1, savedAt: 1_000, source: find(id).source }),
    create: async (script) => {
      const made = saved(`s-${next++}`, script.name, script.source);
      scripts.push(made);
      return made;
    },
    save: async (id, source) => Object.assign(find(id), { source }),
    rename: async (id, name) => Object.assign(find(id), { name }),
    remove: async () => ({ scripts }),
  };
}

/** This browser's storage, in memory (the app reads it through window.localStorage). */
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('The script menu’s Make a copy, Rename and Recently used (pineStore)', () => {
  it('makes a copy under a new name and holds it; the original stays', async () => {
    const api = fakeApi();
    const store = new PineStore(api);
    store.openNew();
    store.setText(RSI);
    expect(await store.save('My RSI')).toBe(true);
    expect(await store.makeCopy('RSI copy')).toBe(true);
    expect(api.scripts.map((item) => [item.name, item.source])).toEqual([
      ['My RSI', RSI],
      ['RSI copy', RSI],
    ]);
    const { document } = store.get();
    expect(document?.origin).toMatchObject({ kind: 'saved', name: 'RSI copy' });
    expect(document?.chartId).toBeNull();
  });

  it('renames the saved script it holds, and only a saved one', async () => {
    const store = new PineStore(fakeApi());
    store.openNew();
    expect(await store.rename('Nope')).toBe(false);
    await store.save('My RSI');
    expect(await store.rename('Faster RSI')).toBe(true);
    expect(store.get().document?.origin).toMatchObject({ kind: 'saved', name: 'Faster RSI' });
  });

  it('keeps the scripts opened lately, the latest first, through a reload', async () => {
    const api = fakeApi();
    const store = new PineStore(api);
    store.openBuiltin('rsi');
    store.openNew();
    await store.save('Mine');
    expect(store.get().recent).toEqual([
      { kind: 'saved', scriptId: 's-1', name: 'Mine' },
      { kind: 'builtin', builtin: 'rsi' },
    ]);
    // Opening one again moves it first, once.
    store.openBuiltin('rsi');
    expect(store.get().recent.map((item) => item.kind)).toEqual(['builtin', 'saved']);
    expect(new PineStore(api).get().recent).toEqual(store.get().recent);
  });

  it('lists a handful, leaving out what isn’t one', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: 'saved',
      scriptId: `s-${i}`,
      name: `S${i}`,
    }));
    expect(sanitizeRecent([...many, { kind: 'saved', scriptId: 'nope' }])).toHaveLength(
      RECENT_COUNT,
    );
    storage.set(RECENT_KEY, '{ broken');
    expect(new PineStore(fakeApi()).get().recent).toEqual([]);
  });

  it('starts Create new → Library from a library', () => {
    const store = new PineStore(fakeApi());
    store.openNew('library');
    expect(store.get().document?.text).toBe(NEW_LIBRARY);
  });
});

describe('Version history’s search', () => {
  const versions = [
    { version: 1, savedAt: Date.UTC(2026, 9, 30, 9, 0) },
    { version: 2, savedAt: Date.UTC(2026, 10, 1, 9, 0) },
  ];

  it('lists the newest first, and finds one by its date or number', () => {
    expect(matchingVersions(versions, '').map((item) => item.version)).toEqual([2, 1]);
    expect(matchingVersions(versions, 'Oct 30').map((item) => item.version)).toEqual([1]);
    expect(matchingVersions(versions, 'version 2').map((item) => item.version)).toEqual([2]);
  });
});
