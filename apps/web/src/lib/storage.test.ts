import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJson, readNumber, writeJson, writeNumber } from './storage';

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

describe('readJson / writeJson', () => {
  it('round-trips a value', () => {
    const store = new Map<string, string>();
    stubStorage({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    });
    writeJson('k', { favorites: ['1', '1D'] });
    expect(readJson('k')).toEqual({ favorites: ['1', '1D'] });
  });

  it('returns null for missing or malformed values, and when storage throws', () => {
    stubStorage({ getItem: () => null });
    expect(readJson('k')).toBeNull();
    stubStorage({ getItem: () => '{not json' });
    expect(readJson('k')).toBeNull();
    stubStorage({
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readJson('k')).toBeNull();
  });

  it('ignores a failed write', () => {
    stubStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => writeJson('k', 1)).not.toThrow();
  });
});
