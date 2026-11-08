import { describe, expect, it } from 'vitest';
import { closes, compileError, indicator, plots, program } from './testing.ts';

/** The newer input kinds (Pine docs, Inputs; the v6 reference's input.* functions). */

const bars = closes([10, 11, 12]);

describe('input.enum', () => {
  const source = indicator(`enum Side
    long = "Long only"
    short = "Short only"
side = input.enum(Side.long, "Side")
plot(side == Side.long ? 1 : -1)`);

  it('lists the members by title, keeping their names in the settings', () => {
    expect(program(source).inputs[0]).toMatchObject({
      kind: 'enum',
      defval: 'long',
      options: ['long', 'short'],
      optionTitles: ['Long only', 'Short only'],
    });
  });

  it('gives the script the member the settings name', () => {
    expect(plots(source, bars)[0]?.[0]).toBe(1);
    expect(plots(source, bars, ['short'])[0]?.[0]).toBe(-1);
    // A name that isn't a member falls back to the default.
    expect(plots(source, bars, ['sideways'])[0]?.[0]).toBe(1);
  });

  it('refuses a default that isn’t an enum’s member', () => {
    expect(compileError(indicator('x = input.enum(1, "X")\nplot(close)')).message).toMatch(
      /must be an enum's member/,
    );
  });
});

describe('timeframe, session, time, price and text inputs', () => {
  it('gives each its type and its own kind in the Inputs tab', () => {
    const p = program(
      indicator(`tf = input.timeframe("D", "TF")
s = input.session("0930-1600", "Session")
t = input.time(timestamp("2024-01-01"), "From")
p = input.price(100.5, "Level")
n = input.text_area("a\\nb", "Notes")
plot(str.length(tf) + str.length(s) + (t > 0 ? 1 : 0) + p + str.length(n))`),
    );
    expect(p.inputs.map((input) => input.kind)).toEqual([
      'timeframe',
      'session',
      'time',
      'price',
      'text_area',
    ]);
    expect(plots(p.source, bars)[0]?.[0]).toBe(1 + 9 + 1 + 100.5 + 3);
  });

  it('runs time() with the session the settings give', () => {
    const source = indicator(
      's = input.session("0000-0000", "Session")\nplot(na(time(timeframe.period, s)) ? 0 : 1)',
    );
    expect(plots(source, bars)[0]?.[0]).toBe(1);
  });
});

describe('settings that take an input', () => {
  it("lets a bool input decide whether a plot's style is editable (an input bool in the reference)", () => {
    // Published scripts do: `plot(…, editable = i_rsi_show_bull)` (found 2026-11-08).
    const p = program(
      indicator(`show = input.bool(true, "Editable")
plot(close, editable = show)
hline(50, editable = show)`),
    );
    expect(p.describe([]).plots[0]?.editable).toBe(true);
    expect(p.describe([false]).plots[0]?.editable).toBe(false);
    expect(p.describe([false]).hlines[0]?.editable).toBe(false);
    // A series can't decide it.
    expect(compileError(indicator('plot(close, editable = close > open)')).message).toMatch(
      /editable/,
    );
  });
});
