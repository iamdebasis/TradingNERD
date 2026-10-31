import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { RSI, RSI_SMOOTHING } from './rsi.ts';
import { IndicatorRun } from './run.ts';
import { defaultSettings } from './settings.ts';
import type { IndicatorDefinition, Inputs, SymbolContext } from './types.ts';
import { VOLUME } from './volume.ts';

const XRP: SymbolContext = { base: 'XRP', hasVolume: true };

/** Bar i of a deterministic walk, as its final candle. */
function finalBar(i: number): Bar {
  const open = 1.3 * (1 + 0.1 * Math.sin(i * 0.31));
  const close = 1.3 * (1 + 0.1 * Math.sin((i + 1) * 0.31) + 0.01 * Math.cos(i * 7.3));
  return {
    time: 1_700_000_000 + i * 60,
    open,
    high: Math.max(open, close) * 1.002,
    low: Math.min(open, close) * 0.998,
    close,
    volume: 500 + ((i * 53) % 211),
  };
}

/** The same bar part way through: a different close and less volume. */
function formingBar(i: number, tick: number): Bar {
  const final = finalBar(i);
  const close = final.open + (final.close - final.open) * (tick / 3) + 0.003 * Math.sin(tick);
  return {
    ...final,
    close,
    high: Math.max(final.open, close),
    low: Math.min(final.open, close),
    volume: final.volume * (tick / 4),
  };
}

const CASES: [string, IndicatorDefinition, Inputs][] = [
  ['Volume', VOLUME, defaultSettings(VOLUME).inputs],
  ['Volume by previous close', VOLUME, { ...defaultSettings(VOLUME).inputs, previousClose: true }],
  ...RSI_SMOOTHING.map((type): [string, IndicatorDefinition, Inputs] => [
    `RSI with ${type}`,
    RSI,
    { ...defaultSettings(RSI).inputs, maType: type },
  ]),
];

function expectSameValues(live: IndicatorRun, fresh: IndicatorRun): void {
  expect(live.length).toBe(fresh.length);
  live.values.forEach((plot, p) => {
    plot.forEach((value, i) => {
      const expected = fresh.values[p]?.[i] as number;
      if (Number.isNaN(expected)) expect(value).toBeNaN();
      else
        expect(Math.abs(value - expected)).toBeLessThanOrEqual(
          1e-12 * Math.max(1, Math.abs(expected)),
        );
    });
  });
  expect(live.growing).toEqual(fresh.growing);
}

describe.each(CASES)('%s, bar by bar', (_name, definition, inputs) => {
  it('equals a run computed in one go, through live ticks and new bars', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 60; i++) bars.push(finalBar(i));
    const live = new IndicatorRun(definition, inputs, XRP);
    live.setBars(bars);
    for (let i = 60; i < 120; i++) {
      bars.push(formingBar(i, 1));
      expect(live.update(bars, 'new', bars.length - 1)).toEqual([i - 1, i]);
      for (let tick = 2; tick <= 3; tick++) {
        bars[i] = formingBar(i, tick);
        expect(live.update(bars, 'tick', i)).toEqual([i]);
      }
      bars[i] = finalBar(i);
      live.update(bars, 'tick', i);
    }
    const fresh = new IndicatorRun(definition, inputs, XRP);
    fresh.setBars(bars);
    expectSameValues(live, fresh);
  });

  it("an exchange's late correction of the bar before the live one gives the values it should", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 80; i++) bars.push(finalBar(i));
    bars[79] = formingBar(79, 1); // the previous bar as last seen live
    const live = new IndicatorRun(definition, inputs, XRP);
    live.setBars(bars);
    bars.push(formingBar(80, 1));
    live.update(bars, 'new', 80);
    bars[79] = finalBar(79); // its final candle arrives after the new bar opened
    expect(live.update(bars, 'correction', 79)).toEqual([79, 80]);
    const fresh = new IndicatorRun(definition, inputs, XRP);
    fresh.setBars(bars);
    expectSameValues(live, fresh);
  });

  it('a change it cannot follow bar by bar is computed afresh', () => {
    const bars = Array.from({ length: 50 }, (_, i) => finalBar(i));
    const live = new IndicatorRun(definition, inputs, XRP);
    live.setBars(bars);
    bars[10] = { ...(bars[10] as Bar), close: 9 };
    expect(live.update(bars, 'correction', 10)).toBe('all');
    const fresh = new IndicatorRun(definition, inputs, XRP);
    fresh.setBars(bars);
    expectSameValues(live, fresh);
  });
});

describe('a run', () => {
  it('starts from no bars, then one, then the next', () => {
    const run = new IndicatorRun(VOLUME, defaultSettings(VOLUME).inputs, XRP);
    run.setBars([]);
    expect(run.length).toBe(0);
    const bars = [finalBar(0)];
    expect(run.update(bars, 'new', 0)).toBe('all');
    bars.push(finalBar(1));
    expect(run.update(bars, 'new', 1)).toEqual([0, 1]);
    expect(run.valuesAt(1)[0]).toBe(finalBar(1).volume);
    expect(run.valuesAt(5)).toEqual([Number.NaN, Number.NaN]);
  });
});
