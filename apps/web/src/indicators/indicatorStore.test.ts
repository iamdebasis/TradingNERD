import { RSI_PINE } from '@tradingnerd/indicators';
import { describe, expect, it } from 'vitest';
import { INDICATORS_VERSION, IndicatorStore, sanitizeIndicators } from './indicatorStore';

const SCRIPT =
  '//@version=6\nindicator("Average")\nn = input.int(14, "Length")\nplot(ta.sma(close, n))\n';

describe('Scripts on the chart, in the indicator store', () => {
  it('adds a script with its code, its defaults and no looks of its own', () => {
    const store = new IndicatorStore();
    const id = store.addScript({ source: SCRIPT, scriptId: null, from: null });
    const [indicator] = store.get().list;
    expect(id).toBe('script-1');
    expect(indicator).toMatchObject({
      kind: 'script',
      script: { source: SCRIPT, scriptId: null, from: null },
      settings: { inputs: { in_0: 14 }, styles: {} },
    });
  });

  it('on Update on chart, inputs left at the old defaults take the new ones; changed ones stay', () => {
    const store = new IndicatorStore();
    const id = store.addScript({ source: RSI_PINE, scriptId: null, from: 'rsi' });
    const settings = store.get().list[0]?.settings;
    if (!settings) throw new Error('not added');
    // The smoothing's length changed in its settings; the RSI's own length left as it was.
    store.setSettings(id, { ...settings, inputs: { ...settings.inputs, in_3: 30 } });
    const edited = RSI_PINE.replace(
      'input.int(14, "RSI Length"',
      'input.int(21, "RSI Length"',
    ).replace('input.int(14, "Length"', 'input.int(20, "Length"');
    store.updateScript(id, { source: edited });
    const after = store.get().list[0];
    expect(after?.script?.source).toBe(edited);
    expect(after?.settings.inputs.in_0).toBe(21);
    expect(after?.settings.inputs.in_3).toBe(30);
  });

  it('keeps a script that doesn’t compile, settings and all, so fixing its code brings them back', () => {
    const broken = '//@version=6\nindicator("x")\nplot(nothing)\n';
    const read = sanitizeIndicators({
      version: INDICATORS_VERSION,
      list: [
        {
          id: 'script-1',
          kind: 'script',
          script: { source: broken, scriptId: null, from: null },
          settings: { inputs: { in_0: 5 }, styles: {} },
          hidden: false,
        },
      ],
    });
    expect(read.list[0]?.settings.inputs).toEqual({ in_0: 5 });
  });

  it('reads a version 1 list as it is, and drops a script entry without code', () => {
    const read = sanitizeIndicators({
      version: 1,
      list: [
        { id: 'rsi-1', kind: 'rsi', settings: {}, hidden: false },
        { id: 'script-1', kind: 'script', settings: {}, hidden: false },
      ],
    });
    expect(read.list.map((item) => item.id)).toEqual(['rsi-1']);
  });
});
