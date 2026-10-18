import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNumber, writeNumber } from './storage';

function stubStorage(storage: Partial<Storage>) {
  vi.stubGlobal('window', { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readNumber', () => {
  it('returns a stored number', () => {
    stubStorage({ getItem: () => '415' });
    expect(readNumber('k')).toBe(415);
  });

  it('returns null when nothing is stored', () => {
    stubStorage({ getItem: () => null });
    expect(readNumber('k')).toBeNull();
  });

  it('returns null for a value that is not a number', () => {
    stubStorage({ getItem: () => 'wide' });
    expect(readNumber('k')).toBeNull();
  });

  it('returns null when storage throws', () => {
    stubStorage({
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readNumber('k')).toBeNull();
  });
});

describe('writeNumber', () => {
  it('stores the number as a string', () => {
    const setItem = vi.fn();
    stubStorage({ setItem });
    writeNumber('k', 415);
    expect(setItem).toHaveBeenCalledWith('k', '415');
  });

  it('swallows storage errors', () => {
    stubStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => writeNumber('k', 1)).not.toThrow();
  });
});
