import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEPT_FOLDED, OBJECT_TREE_FOLDED_KEY, ObjectTreeStore } from './objectTreeStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Object tree’s panel and its requests (D3c)', () => {
  it('opens, counting each time it’s shown, even while open, and closes', () => {
    const store = new ObjectTreeStore();
    let told = 0;
    store.subscribe(() => {
      told += 1;
    });
    store.show();
    store.show();
    expect(store.get()).toMatchObject({ open: true, shown: 2 });
    store.close();
    store.close();
    expect(store.get()).toMatchObject({ open: false, shown: 2 });
    expect(told).toBe(3);
  });

  it('numbers its requests in order, keeping the latest sixteen', () => {
    const store = new ObjectTreeStore();
    store.ask({ kind: 'select', ids: ['a'] });
    store.ask({ kind: 'drawing-settings', ids: ['a', 'b'] });
    store.ask({ kind: 'indicator-settings', id: 'rsi-1' });
    expect(store.get().requests).toEqual([
      { kind: 'select', ids: ['a'], seq: 1 },
      { kind: 'drawing-settings', ids: ['a', 'b'], seq: 2 },
      { kind: 'indicator-settings', id: 'rsi-1', seq: 3 },
    ]);
    for (let i = 0; i < 20; i++) store.ask({ kind: 'select', ids: [] });
    const { requests } = store.get();
    expect(requests).toHaveLength(16);
    expect(requests.map((request) => request.seq)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 8),
    );
  });

  it('folds groups and opens them again, kept in this browser, the latest few hundred', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
    const store = new ObjectTreeStore();
    store.setFolded('g1', true);
    store.setFolded('g2', true);
    store.setFolded('g1', false);
    expect([...store.get().folded]).toEqual(['g2']);
    expect(JSON.parse(stored.get(OBJECT_TREE_FOLDED_KEY) ?? '[]')).toEqual(['g2']);
    expect([...new ObjectTreeStore().get().folded]).toEqual(['g2']);
    for (let i = 0; i < KEPT_FOLDED + 5; i++) store.setFolded(`x${i}`, true);
    expect(store.get().folded.size).toBe(KEPT_FOLDED);
    expect(store.get().folded.has('g2')).toBe(false);
  });
});
