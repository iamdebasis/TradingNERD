import { describe, expect, it } from 'vitest';
import { ObjectTreeStore } from './objectTreeStore';

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
});
