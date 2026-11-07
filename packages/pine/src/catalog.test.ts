import { describe, expect, it } from 'vitest';
import { catalog, catalogEntry, namespaceMembers, referenceUrl, signatureOf } from './catalog.ts';
import { compileScript } from './script.ts';

/** The editor's help while typing: what our engine has, never more (docs/SPEC.md §5.18). */

describe('The catalog of built-ins', () => {
  it('lists only values the engine compiles', () => {
    const values = catalog().filter(
      (entry) => entry.kind === 'variable' || entry.kind === 'constant',
    );
    const broken = values.filter((entry) => {
      const result = compileScript(`//@version=6\nindicator("x")\nx = ${entry.name}\nplot(close)`);
      return !result.ok;
    });
    expect(broken.map((entry) => entry.name)).toEqual([]);
    expect(values.length).toBeGreaterThan(150);
  });

  it('lists the engine’s functions, by namespace', () => {
    expect(catalogEntry('ta.sma')).toEqual({ name: 'ta.sma', kind: 'function' });
    expect(catalogEntry('ta')?.kind).toBe('namespace');
    const ta = namespaceMembers('ta').map((entry) => entry.name);
    expect(ta).toContain('ta.rsi');
    expect(ta).toContain('ta.tr');
    expect(namespaceMembers('color').map((entry) => entry.name)).toContain('color.red');
    // Internal helpers stay out.
    expect(catalog().some((entry) => entry.name.startsWith('__'))).toBe(false);
  });

  it('reads a function’s parameters from the engine itself', () => {
    expect(signatureOf('ta.sma')).toEqual([{ params: ['source', 'length'], required: 2 }]);
    expect(signatureOf('ta.change')[0]).toEqual({ params: ['source', 'length'], required: 1 });
    expect(signatureOf('plotshape')[0]?.params.slice(0, 4)).toEqual([
      'series',
      'title',
      'style',
      'location',
    ]);
  });

  it('links each entry to TradingView’s reference', () => {
    const at = (name: string) => {
      const entry = catalogEntry(name);
      return entry ? referenceUrl(entry) : null;
    };
    expect(at('ta.sma')).toBe('https://www.tradingview.com/pine-script-reference/v6/#fun_ta.sma');
    expect(at('close')).toBe('https://www.tradingview.com/pine-script-reference/v6/#var_close');
    expect(at('color.red')).toBe(
      'https://www.tradingview.com/pine-script-reference/v6/#const_color.red',
    );
    expect(at('ta')).toBeNull();
  });
});
