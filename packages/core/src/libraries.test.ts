import { describe, expect, it } from 'vitest';
import {
  libraryPath,
  parseLibrariesIndex,
  parseLibraryPath,
  parseLibraryRef,
  parseLibrarySource,
  sameLibrary,
} from './libraries.ts';
import { MAX_SCRIPT_SOURCE } from './scripts.ts';

describe('A library’s import path (Pine docs, Libraries)', () => {
  it('reads user/library/version as an import writes it', () => {
    expect(parseLibraryPath(' JollyWizard/lib_hlm/1 ')).toEqual({
      publisher: 'JollyWizard',
      name: 'lib_hlm',
      version: 1,
    });
    expect(libraryPath({ publisher: 'TradingView', name: 'ta', version: 7 })).toBe(
      'TradingView/ta/7',
    );
  });

  it('refuses what isn’t one', () => {
    for (const bad of ['TradingView/ta', 'TradingView/ta/0', 'a/b/c', 'a b/c/1', '../b/1', '']) {
      expect(parseLibraryPath(bad)).toBeNull();
    }
    expect(parseLibraryRef('a', 'b', 1.5)).toBeNull();
    expect(parseLibraryRef('a', 'b'.repeat(65), 1)).toBeNull();
  });

  it('compares paths with their case aside', () => {
    const a = { publisher: 'PineCoders', name: 'Time', version: 4 };
    expect(sameLibrary(a, { ...a, publisher: 'pinecoders' })).toBe(true);
    expect(sameLibrary(a, { ...a, version: 5 })).toBe(false);
  });
});

describe('Kept libraries', () => {
  const library = {
    publisher: 'TradingView',
    name: 'ta',
    version: 7,
    source: '//@version=6\nlibrary("ta")',
    addedAt: 1,
  };

  it('keeps code that isn’t empty, up to a script’s size', () => {
    expect(parseLibrarySource(' \n ')).toBeNull();
    expect(parseLibrarySource('x'.repeat(MAX_SCRIPT_SOURCE + 1))).toBeNull();
    expect(parseLibrarySource(library.source)).toBe(library.source);
  });

  it('lists each path once', () => {
    expect(parseLibrariesIndex({ libraries: [library] })).toEqual({ libraries: [library] });
    expect(
      parseLibrariesIndex({ libraries: [library, { ...library, publisher: 'tradingview' }] }),
    ).toBeNull();
    expect(parseLibrariesIndex({ libraries: [{ ...library, addedAt: -1 }] })).toBeNull();
  });
});
