import { describe, expect, it } from 'vitest';
import type { LibraryResolver } from './compiler.ts';
import { compileCached, compileScript, ScriptRun } from './script.ts';
import { closes } from './testing.ts';

/**
 * Libraries (Pine docs, Libraries): a script imports `user/name/version [as alias]` and calls
 * what the library exports; the app supplies each library's code (the user pastes it).
 */

const HLM = `//@version=5
// @description Highs, lows and their middle.
library("lib_hlm")
// @function The middle of a high and a low.
export hl2(float h, float l) => (h + l) / 2
export type Range
    float top
    float bottom
export method width(Range r) => r.top - r.bottom
export enum Side
    up = "Up"
    down = "Down"
hidden(float x) => x
plot(hl2(high, low))`;

const ICHIMOKU = `//@version=5
indicator("Ichimoku with a library", overlay = true)
import JollyWizard/lib_hlm/1 as hlm
r = hlm.Range.new(high, low)
plot(hlm.hl2(high, low), "Middle")
plot(r.width(), "Width")
plot(hlm.Side.up == hlm.Side.up ? 1 : 0, "Side")`;

const libraries = (codes: Record<string, string>): LibraryResolver => {
  return (publisher, name, version) => codes[`${publisher}/${name}/${version}`] ?? null;
};

const bars = closes([10, 11, 12, 11]);

describe('A script that imports a library', () => {
  it('calls its exported functions, types, methods and enums through the alias', () => {
    const result = compileScript(ICHIMOKU, {
      resolveLibrary: libraries({ 'JollyWizard/lib_hlm/1': HLM }),
    });
    if (!result.ok) throw new Error(result.errors[0]?.message);
    const run = new ScriptRun(result.program, []);
    run.setBars(bars, true);
    const [middle, width, side] = run.values.map((values) => Array.from(values.slice(0, 4)));
    expect(middle).toEqual(bars.map((bar) => (bar.high + bar.low) / 2));
    expect(width).toEqual(bars.map((bar) => bar.high - bar.low));
    expect(side).toEqual([1, 1, 1, 1]);
    // The library's own plot isn't the script's.
    expect(run.values).toHaveLength(3);
  });

  it('names it by the library’s name without an alias', () => {
    const result = compileScript(
      '//@version=6\nindicator("X")\nimport JollyWizard/lib_hlm/1\nplot(lib_hlm.hl2(high, low))',
      { resolveLibrary: libraries({ 'JollyWizard/lib_hlm/1': HLM }) },
    );
    expect(result.ok).toBe(true);
  });

  it('refuses what the library doesn’t export', () => {
    const result = compileScript(
      '//@version=6\nindicator("X")\nimport JollyWizard/lib_hlm/1 as hlm\nplot(hlm.hidden(close))',
      { resolveLibrary: libraries({ 'JollyWizard/lib_hlm/1': HLM }) },
    );
    expect(result.ok ? null : result.errors[0]?.message).toMatch(/isn't exported|doesn't export/);
  });
});

describe('An import that can’t be used says which library, for "Add library…"', () => {
  const errorOf = (source: string, codes: Record<string, string>) => {
    const result = compileScript(source, { resolveLibrary: libraries(codes) });
    if (result.ok) throw new Error('It compiled');
    return result.errors[0];
  };

  it('a library not added: its path, at the import', () => {
    const error = errorOf(ICHIMOKU, {});
    expect(error).toMatchObject({
      line: 3,
      message: expect.stringMatching(/^Could not find library "JollyWizard\/lib_hlm\/1"/),
      library: { path: 'JollyWizard/lib_hlm/1', problem: 'missing' },
    });
  });

  it('a library whose code has an error, or that isn’t a library', () => {
    expect(
      errorOf(ICHIMOKU, { 'JollyWizard/lib_hlm/1': '//@version=5\nlibrary("x")\nexport f() => (' }),
    ).toMatchObject({
      line: 3,
      message: expect.stringMatching(/^The library "JollyWizard\/lib_hlm\/1" has an error/),
      library: { path: 'JollyWizard/lib_hlm/1', problem: 'error' },
    });
    expect(
      errorOf(ICHIMOKU, { 'JollyWizard/lib_hlm/1': '//@version=5\nindicator("x")\nplot(close)' }),
    ).toMatchObject({ library: { problem: 'error' } });
  });

  it('a library the library imports: that one, at the script’s own import', () => {
    const outer = '//@version=6\nlibrary("outer")\nimport PineCoders/Time/4 as t\nexport f() => 1';
    const error = errorOf('//@version=6\nindicator("X")\nimport Me/outer/1 as o\nplot(o.f())', {
      'Me/outer/1': outer,
    });
    expect(error).toMatchObject({
      line: 3,
      library: { path: 'PineCoders/Time/4', problem: 'missing' },
    });
  });
});

describe('Libraries and the compile cache', () => {
  it('compiles again when the libraries change (their revision)', () => {
    const missing = compileCached(ICHIMOKU, { resolveLibrary: libraries({}), revision: '1' });
    expect(missing.ok).toBe(false);
    const added = compileCached(ICHIMOKU, {
      resolveLibrary: libraries({ 'JollyWizard/lib_hlm/1': HLM }),
      revision: '2',
    });
    expect(added.ok).toBe(true);
  });

  it('knows a library from an indicator', () => {
    const result = compileScript(HLM);
    expect(result.ok && result.program.isLibrary).toBe(true);
  });

  it('refuses a library that exports nothing, as the reference says each must', () => {
    const result = compileScript(
      '//@version=6\nlibrary("Nothing")\nf(float x) => x\nplot(f(close))',
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]).toMatchObject({
      message: 'A library must export at least one function or type',
      line: 2,
    });
  });
});
