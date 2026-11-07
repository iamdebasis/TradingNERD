import type { LibraryRef, SavedLibrary } from '@tradingnerd/core';
import { compileCached } from '@tradingnerd/pine';
import { describe, expect, it } from 'vitest';
import { ApiError, type LibrariesApi } from '../data/api';
import { definitionOf } from '../indicators/definitions';
import { IndicatorStore } from '../indicators/indicatorStore';
import { libraryProblem } from './LibrariesDialog';
import { LibrariesStore, librariesStore } from './librariesStore';
import { NEW_LIBRARY } from './pineStore';

const HLM = '//@version=5\nlibrary("lib_hlm")\nexport hl2(float h, float l) => (h + l) / 2';
const USES = `//@version=5
indicator("Middle", overlay = true)
import JollyWizard/lib_hlm/1 as hlm
plot(hlm.hl2(high, low))`;
const ref: LibraryRef = { publisher: 'JollyWizard', name: 'lib_hlm', version: 1 };

/** The gateway's routes, kept in memory as the LibrariesStore of apps/gateway keeps them. */
function fakeApi(failLoad = false): LibrariesApi & { kept: SavedLibrary[] } {
  const kept: SavedLibrary[] = [];
  const same = (a: LibraryRef, b: LibraryRef) =>
    `${a.publisher}/${a.name}/${a.version}`.toLowerCase() ===
    `${b.publisher}/${b.name}/${b.version}`.toLowerCase();
  return {
    kept,
    index: async () => {
      if (failLoad) throw new ApiError('network', "The gateway couldn't be reached");
      return { libraries: [...kept] };
    },
    put: async (at, source) => {
      const saved = { ...at, source, addedAt: 1 };
      const index = kept.findIndex((item) => same(item, at));
      if (index >= 0) kept.splice(index, 1);
      kept.push(saved);
      return saved;
    },
    remove: async (at) => {
      const index = kept.findIndex((item) => same(item, at));
      if (index < 0) throw new ApiError('not_found', 'There is no such library');
      kept.splice(index, 1);
      return { libraries: [...kept] };
    },
  };
}

describe('The libraries scripts import (librariesStore)', () => {
  it('finds a library by the path as the import writes it', async () => {
    const store = new LibrariesStore(fakeApi());
    await store.load();
    expect(store.resolve('JollyWizard', 'lib_hlm', 1)).toBeNull();
    expect(await store.add(ref, HLM)).toBeNull();
    expect(store.resolve('JollyWizard', 'lib_hlm', 1)).toBe(HLM);
    // Another spelling isn't the import's: the user adds it again under the import's.
    expect(store.resolve('jollywizard', 'lib_hlm', 1)).toBeNull();
  });

  it('moves its revision on with each change, so scripts compile again', async () => {
    const store = new LibrariesStore(fakeApi());
    await store.load();
    const before = store.compileOptions();
    expect(compileCached(USES, before).ok).toBe(false);
    await store.add(ref, HLM);
    const after = store.compileOptions();
    expect(after.revision).not.toBe(before.revision);
    expect(compileCached(USES, after).ok).toBe(true);
    // The same object until the next change: compileCached keeps its result.
    expect(store.compileOptions()).toBe(after);
    await store.remove(ref);
    expect(compileCached(USES, store.compileOptions()).ok).toBe(false);
  });

  it('replaces a library added again in another spelling, keeping the new one', async () => {
    const api = fakeApi();
    const store = new LibrariesStore(api);
    await store.load();
    await store.add({ ...ref, publisher: 'jollywizard' }, HLM);
    await store.add(ref, HLM);
    expect(store.get().libraries?.map((item) => item.publisher)).toEqual(['JollyWizard']);
    expect(api.kept).toHaveLength(1);
  });

  it('says why a change failed, and compiles without libraries when the gateway is away', async () => {
    const store = new LibrariesStore(fakeApi(true));
    await store.load();
    expect(store.get()).toMatchObject({ libraries: [], error: "The gateway couldn't be reached" });
    expect(await store.remove(ref)).toBe('There is no such library');
  });
});

describe('Adding a library: what the dialog checks before it saves', () => {
  it('wants a path as an import writes it, and code that compiles as a library', () => {
    expect(libraryProblem('JollyWizard/lib_hlm', HLM)).toMatch(/user\/library\/version/);
    expect(libraryProblem('JollyWizard/lib_hlm/1', ' ')).toMatch(/Paste the library's code/);
    expect(libraryProblem('JollyWizard/lib_hlm/1', 'library("x")\nexport f() => (')).toMatch(
      /^Line \d+:/,
    );
    expect(
      libraryProblem('JollyWizard/lib_hlm/1', '//@version=6\nindicator("Not one")\nplot(close)'),
    ).toMatch(/isn't a library/);
    expect(libraryProblem('JollyWizard/lib_hlm/1', HLM)).toBeNull();
  });

  it('starts Create new → Library with code that is one', () => {
    expect(libraryProblem('Me/MyLibrary/1', NEW_LIBRARY)).toBeNull();
  });
});

describe('A script on the chart that imports', () => {
  it('reads as a broken script until its library is added, then as its own', async () => {
    const indicators = new IndicatorStore();
    indicators.addScript({ source: USES, scriptId: null, from: null });
    const [indicator] = indicators.get().list;
    if (!indicator) throw new Error('not added');
    expect(definitionOf(indicator).plots).toEqual([]);
    const api = fakeApi();
    // The app's own store, with the fake gateway in place.
    Object.assign(librariesStore, { api });
    expect(await librariesStore.add(ref, HLM)).toBeNull();
    expect(definitionOf(indicator).plots).toHaveLength(1);
    await librariesStore.remove(ref);
  });
});
