import type { Bar } from '@tradingnerd/core';
import { compileScript, type ScriptProgram, ScriptRun, type ScriptSymbol } from './index.ts';
import { DEFAULT_SYMBOL } from './runtime.ts';

/**
 * Bars and helpers for this package's tests: the same deterministic walk as the indicators
 * package's tests, so their numbers can be compared.
 */
export function walkBar(i: number): Bar {
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

export const walk = (count: number, from = 0): Bar[] =>
  Array.from({ length: count }, (_, i) => walkBar(from + i));

/** Bars with these closes (open the close before, high and low around them). */
export function closes(values: readonly number[]): Bar[] {
  return values.map((close, i) => {
    const open = i === 0 ? close : (values[i - 1] as number);
    return {
      time: 1_700_000_000 + i * 60,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + i,
    };
  });
}

/** The same bar part way through: another close and less volume. */
export function forming(bar: Bar, tick: number): Bar {
  const close = bar.open + (bar.close - bar.open) * (tick / 3) + 0.003 * Math.sin(tick);
  return {
    ...bar,
    close,
    high: Math.max(bar.open, close),
    low: Math.min(bar.open, close),
    volume: bar.volume * (tick / 4),
  };
}

/** A script that must compile. */
export function program(source: string): ScriptProgram {
  const result = compileScript(source);
  if (!result.ok) {
    const lines = result.errors.map((e) => `${e.line}:${e.column} ${e.message}`);
    throw new Error(`The script doesn't compile:\n${lines.join('\n')}`);
  }
  return result.program;
}

/** The first error a script's compile gives, with where it is. */
export function compileError(source: string): { message: string; line: number; column: number } {
  const result = compileScript(source);
  if (result.ok) throw new Error('The script compiled');
  const error = result.errors[0] as { message: string; line: number; column: number };
  return { message: error.message, line: error.line, column: error.column };
}

/** A body under the version line and an indicator() declaration. */
export const indicator = (body: string, declaration = 'indicator("Test")') =>
  `//@version=6\n${declaration}\n${body}`;

/** A script run over the bars as if our first bar were the listing: every value shows. */
export function runScript(
  source: string,
  bars: readonly Bar[],
  inputs: readonly unknown[] = [],
  symbol: ScriptSymbol = DEFAULT_SYMBOL,
): ScriptRun {
  const p = program(source);
  const run = new ScriptRun(p, inputs, symbol);
  run.setBars(bars, true);
  return run;
}

/** Each plot's values over the bars. */
export function plots(
  source: string,
  bars: readonly Bar[],
  inputs: readonly unknown[] = [],
  symbol: ScriptSymbol = DEFAULT_SYMBOL,
): number[][] {
  const run = runScript(source, bars, inputs, symbol);
  if (run.error) throw new Error(`Runtime error on bar ${run.error.bar}: ${run.error.message}`);
  return run.values.map((values) => Array.from(values.subarray(0, bars.length)));
}

/** The values of a script's first plot, its body under an indicator() declaration. */
export const series = (body: string, bars: readonly Bar[]): number[] =>
  plots(indicator(body), bars)[0] as number[];

/** Whether two numbers are the same to within rounding (na equal to na). */
export function close(a: number, b: number, relative = 1e-12): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return Math.abs(a - b) <= relative * Math.max(1, Math.abs(a), Math.abs(b));
}

/** The first index where two series differ, or -1. */
export function firstDifference(
  a: readonly number[],
  b: readonly number[],
  relative = 1e-12,
): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!close(a[i] ?? Number.NaN, b[i] ?? Number.NaN, relative)) return i;
  }
  return -1;
}
