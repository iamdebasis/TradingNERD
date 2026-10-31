import { describe, expect, it } from 'vitest';
import { definitionOf } from './definitions';
import { IndicatorStore } from './indicatorStore';

const SCRIPT =
  '//@version=6\nindicator("Average", overlay = true)\nplot(ta.sma(close, input.int(9, "Length")))\n';

describe('A script’s definition, as the legend and the settings dialog read it', () => {
  it('is remembered for each price precision, so asking with both in turn rebuilds neither', () => {
    const store = new IndicatorStore();
    store.addScript({ source: SCRIPT, scriptId: null, from: null });
    const [indicator] = store.get().list;
    if (!indicator) throw new Error('not added');
    // The legend's values ask with the symbol's precision; its rows with the default.
    const withSymbols = definitionOf(indicator, 4);
    const withDefault = definitionOf(indicator);
    expect(definitionOf(indicator, 4)).toBe(withSymbols);
    expect(definitionOf(indicator)).toBe(withDefault);
    expect(withSymbols.placement).toBe('price');
  });
});
