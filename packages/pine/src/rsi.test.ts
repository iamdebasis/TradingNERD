import type { Bar } from '@tradingnerd/core';
import {
  defaultSettings,
  IndicatorRun,
  type Inputs,
  RSI,
  RSI_PINE,
  RSI_SMOOTHING,
  type SymbolContext,
} from '@tradingnerd/indicators';
import { describe, expect, it } from 'vitest';
import { colorHex, colorOpacity, DEFAULT_SYMBOL, DISPLAY, ScriptRun } from './index.ts';
import { firstDifference, forming, program, walk, walkBar } from './testing.ts';

/**
 * The built-in RSI's Pine code (packages/indicators/src/rsi.pine.ts) against the built-in itself
 * (rsi.ts): the same inputs, plots, levels and fills, and the same values on every bar.
 */
const PROGRAM = program(RSI_PINE);
const PLOT_IDS = ['rsi', 'ma', 'bbUpper', 'bbLower'];

/** Whether the built-in has a plot for these inputs. */
const plotShown = (id: string, inputs: Inputs) =>
  RSI.plots.find((plot) => plot.id === id)?.shownWhen?.(inputs) ?? true;

/** The Pine inputs, in order, for the built-in's settings. */
const pineInputs = (inputs: Inputs) => [
  inputs.length,
  inputs.source,
  inputs.maType,
  inputs.maLength,
  inputs.bbMult,
];

function both(inputs: Inputs, hasVolume: boolean): [IndicatorRun, ScriptRun] {
  const symbol: SymbolContext = { base: 'XRP', hasVolume };
  return [
    new IndicatorRun(RSI, inputs, symbol),
    new ScriptRun(PROGRAM, pineInputs(inputs), { ...DEFAULT_SYMBOL, hasVolume }),
  ];
}

/** Each of the built-in's plots against the script's, bar for bar. */
function expectSameValues(builtin: IndicatorRun, script: ScriptRun, inputs: Inputs): void {
  expect(script.error).toBeNull();
  expect(script.length).toBe(builtin.length);
  PLOT_IDS.forEach((id, p) => {
    if (!plotShown(id, inputs)) return;
    const ours = Array.from((script.values[p] as Float64Array).subarray(0, script.length));
    expect(firstDifference(ours, builtin.values[p] as number[], 1e-12), id).toBe(-1);
  });
}

const CASES = RSI_SMOOTHING.flatMap((maType) => [
  { maType, source: 'close', hasVolume: true },
  { maType, source: 'hlc3', hasVolume: maType !== 'VWMA' },
]);

describe('RSI’s Pine code, against the built-in RSI', () => {
  const BARS = walk(20_000);

  it.each(CASES)(
    'gives the same values over 20,000 bars: $maType on $source, volume $hasVolume',
    ({ maType, source, hasVolume }) => {
      const inputs = {
        ...defaultSettings(RSI).inputs,
        maType,
        source,
        length: 9,
        maLength: 21,
        bbMult: 2.5,
      };
      const [builtin, script] = both(inputs, hasVolume);
      builtin.setBars(BARS);
      script.setBars(BARS, false);
      expectSameValues(builtin, script, inputs);
    },
  );

  it.each(RSI_SMOOTHING)('stays the same through ticks, new bars and corrections: %s', (maType) => {
    const inputs = { ...defaultSettings(RSI).inputs, maType };
    const [builtin, script] = both(inputs, true);
    const bars: Bar[] = walk(600);
    bars[599] = forming(walkBar(599), 1);
    builtin.setBars(bars);
    script.setBars(bars, false);
    for (let i = 600; i < 700; i++) {
      for (let tick = 1; tick <= 3; tick++) {
        bars[bars.length - 1] = forming(walkBar(i - 1), tick);
        builtin.update(bars, 'tick', bars.length - 1);
        script.update(bars, 'tick', bars.length - 1);
      }
      bars[bars.length - 1] = walkBar(i - 1);
      bars.push(forming(walkBar(i), 1));
      builtin.update(bars, 'new', bars.length - 1);
      script.update(bars, 'new', bars.length - 1);
      if (i % 7 === 0) {
        const bar = walkBar(i - 1);
        bars[bars.length - 2] = { ...bar, close: bar.close * 0.999, low: bar.low * 0.999 };
        builtin.update(bars, 'correction', bars.length - 2);
        script.update(bars, 'correction', bars.length - 2);
      }
      expectSameValues(builtin, script, inputs);
    }
  });

  it('draws from where its values match a run with 3,000 more bars of history, no later than the built-in', () => {
    // Bars 3,000 on are ours; the run from bar 0 stands in for TradingView's longer history.
    const history = walk(6_000);
    for (const maType of RSI_SMOOTHING) {
      const inputs = { ...defaultSettings(RSI).inputs, maType };
      const ours = new ScriptRun(PROGRAM, pineInputs(inputs));
      ours.setBars(history.slice(3_000), false);
      const longer = new ScriptRun(PROGRAM, pineInputs(inputs));
      longer.setBars(history, true);
      PLOT_IDS.forEach((id, p) => {
        if (!plotShown(id, inputs)) return;
        const start = ours.plotStarts[p] as number;
        expect(start, `${maType} ${id}`).toBeLessThanOrEqual(RSI.settledFrom(id, inputs));
        expect(start, `${maType} ${id}`).toBeGreaterThan(250);
        let largest = 0;
        for (let k = start; k < 3_000; k++) {
          const a = (ours.values[p] as Float64Array)[k] as number;
          const b = (longer.values[p] as Float64Array)[k + 3_000] as number;
          largest = Math.max(largest, Math.abs(a - b));
        }
        // A hundred-millionth of an RSI point: the legend shows two decimals.
        expect(largest, `${maType} ${id}`).toBeLessThan(1e-8);
      });
    }
  });
});

describe('RSI’s Pine code describes the built-in', () => {
  const settings = defaultSettings(RSI);
  const d = PROGRAM.describe(PROGRAM.defaults());

  it('has the built-in’s inputs, groups, limits and options, in order', () => {
    expect(PROGRAM.defaults()).toEqual(pineInputs(settings.inputs));
    const rows = d.inputs.map((input) => [input.title, input.group, input.minval, input.maxval]);
    expect(rows).toEqual(
      RSI.inputs.map((spec) => [
        spec.title,
        spec.group,
        'min' in spec ? spec.min : undefined,
        'max' in spec ? spec.max : undefined,
      ]),
    );
    expect(d.inputs[2]?.options).toEqual([...RSI_SMOOTHING]);
  });

  it('shows only length and source in the legend, as the built-in does', () => {
    expect(d.inputs.map((input) => (input.display & DISPLAY.status_line) !== 0)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('greys the smoothing length and the bands’ deviation out as the built-in does', () => {
    for (const maType of RSI_SMOOTHING) {
      const inputs = { ...settings.inputs, maType };
      const active = PROGRAM.describe(pineInputs(inputs)).inputs.map((input) => input.active);
      expect(active.slice(3)).toEqual([
        RSI.inputs[3]?.enabledWhen?.(inputs) ?? true,
        RSI.inputs[4]?.enabledWhen?.(inputs) ?? true,
      ]);
    }
  });

  it('draws the built-in’s plots, levels and fills in its colors', () => {
    const shown = d.plots.filter((plot) => plot.editable);
    expect(shown.map((plot) => plot.title)).toEqual(RSI.plots.map((plot) => plot.title));
    shown.forEach((plot, p) => {
      const style = RSI.plots[p]?.style;
      expect(colorHex(plot.color as number)).toBe(style?.color);
      expect(colorOpacity(plot.color as number)).toBe(style?.opacity);
    });
    expect(
      d.hlines.map((h) => [
        h.title,
        h.price,
        colorHex(h.color as number),
        colorOpacity(h.color as number),
      ]),
    ).toEqual(
      RSI.levels.map((level) => [
        level.title,
        level.style.value,
        level.style.color,
        level.style.opacity,
      ]),
    );
    const fills = Object.fromEntries(d.fills.map((fill) => [fill.title, fill]));
    for (const spec of RSI.fills) {
      const fill = fills[spec.title];
      expect(fill, spec.title).toBeDefined();
      expect(colorHex(fill?.color as number)).toBe(spec.style.color);
      expect(colorOpacity(fill?.color as number)).toBeCloseTo(spec.style.opacity, 2);
      if (spec.gradient) {
        expect(fill?.gradient).toMatchObject({
          top: spec.gradient.top,
          bottom: spec.gradient.bottom,
        });
        expect(colorOpacity(fill?.gradient?.bottomColor as number)).toBeCloseTo(
          spec.style.bottomOpacity as number,
          2,
        );
      }
    }
  });

  it('shows the moving average and the bands only for the smoothing types that have them', () => {
    for (const maType of RSI_SMOOTHING) {
      const inputs = { ...settings.inputs, maType };
      const plots = PROGRAM.describe(pineInputs(inputs)).plots;
      PLOT_IDS.forEach((id, p) => {
        expect(plots[p]?.display !== DISPLAY.none, `${maType} ${id}`).toBe(plotShown(id, inputs));
      });
    }
  });
});
