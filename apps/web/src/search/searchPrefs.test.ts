import { describe, expect, it } from 'vitest';
import { searchKey } from './searchPrefs';

const key = (
  k: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {},
) => searchKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });

describe('typing on the chart', () => {
  it('opens symbol search with a letter, as TradingView does', () => {
    expect(key('x')).toBe('x');
    expect(key('B')).toBe('B');
  });

  it('leaves digits, other keys and shortcuts alone', () => {
    expect(key('5')).toBeNull(); // the interval prompt's
    expect(key('Enter')).toBeNull();
    expect(key('ArrowUp')).toBeNull();
    expect(key('r', { altKey: true })).toBeNull(); // Alt+R resets the chart
    expect(key('k', { metaKey: true })).toBeNull();
    expect(key('é')).toBeNull();
  });
});
