import { type ChartIndicator, scriptDefinition } from '@tradingnerd/chart';
import {
  type IndicatorDefinition,
  type IndicatorKind,
  indicatorDefinition,
  RSI_PINE,
} from '@tradingnerd/indicators';
import {
  compileCached,
  DEFAULT_SYMBOL,
  type PineDiagnostic,
  type ScriptProgram,
} from '@tradingnerd/pine';

/** Decimals for a script's inherited format before the chart says (its symbol's own). */
const DEFAULT_PRICE_DECIMALS = 2;

/**
 * The built-ins whose Pine code we have (docs/SPEC.md §5.16): the legend's Source code button
 * and the editor's "Built-in…" open these. Volume's comes later (P2).
 */
export const BUILTIN_CODE: Partial<Record<IndicatorKind, string>> = { rsi: RSI_PINE };

/** A script's compiled code, or its first error. */
export function compiled(
  source: string,
): { program: ScriptProgram; error: null } | { program: null; error: PineDiagnostic } {
  const result = compileCached(source);
  if (result.ok) return { program: result.program, error: null };
  const error = result.errors[0] as PineDiagnostic;
  return { program: null, error };
}

/** A script that doesn't compile: a definition with nothing in it, named for the legend. */
function brokenDefinition(name: string): IndicatorDefinition {
  return {
    kind: 'script',
    name,
    shortName: name,
    aliases: [],
    placement: 'pane',
    format: { kind: 'decimals', decimals: 2 },
    inputs: [],
    plots: [],
    levels: [],
    fills: [],
    styleOverrides: true,
    legendName: () => name,
    legendInputs: () => '',
    create: () => {
      throw new Error('This script has an error');
    },
    settledFrom: () => Number.POSITIVE_INFINITY,
  };
}

/** Each script's definitions, one per price precision asked for. */
const memo = new WeakMap<ChartIndicator, Map<number, IndicatorDefinition>>();

/**
 * An indicator's definition, as the legend and the settings dialog read it: a built-in's, or its
 * script's as its inputs make it (one that doesn't compile has nothing in it). Remembered per
 * indicator and precision, since the legend's values ask with the symbol's and its rows with the
 * default, bar after bar: a change to the indicator makes a new one.
 */
export function definitionOf(
  indicator: ChartIndicator,
  priceDecimals = DEFAULT_PRICE_DECIMALS,
): IndicatorDefinition {
  if (indicator.kind !== 'script') return indicatorDefinition(indicator.kind);
  let byDecimals = memo.get(indicator);
  if (!byDecimals) {
    byDecimals = new Map();
    memo.set(indicator, byDecimals);
  }
  const hit = byDecimals.get(priceDecimals);
  if (hit) return hit;
  const { program } = compiled(indicator.script?.source ?? '');
  const definition = program
    ? scriptDefinition(program, indicator.settings.inputs, {
        symbol: DEFAULT_SYMBOL,
        priceDecimals,
      })
    : brokenDefinition('Script');
  byDecimals.set(priceDecimals, definition);
  return definition;
}
