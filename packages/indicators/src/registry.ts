import { RSI } from './rsi.ts';
import type { IndicatorDefinition, IndicatorKind } from './types.ts';
import { VOLUME } from './volume.ts';

/** Every built-in we have, in the Indicators dialog's order: by name, as TradingView lists them. */
export const INDICATORS: readonly IndicatorDefinition[] = [RSI, VOLUME].sort((a, b) =>
  a.name.localeCompare(b.name),
);

const BY_KIND = new Map<IndicatorKind, IndicatorDefinition>(INDICATORS.map((d) => [d.kind, d]));

export const isIndicatorKind = (value: unknown): value is IndicatorKind =>
  BY_KIND.has(value as IndicatorKind);

export function indicatorDefinition(kind: IndicatorKind): IndicatorDefinition {
  const definition = BY_KIND.get(kind);
  if (!definition) throw new Error(`No built-in indicator "${kind}"`);
  return definition;
}

/**
 * The built-ins a search finds, in the dialog's order: every word typed must start a word of the
 * name, the short name or an alias ("rsi", "relative str", "vol").
 */
export function searchIndicators(query: string): IndicatorDefinition[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...INDICATORS];
  return INDICATORS.filter((definition) => {
    const names = [definition.name, definition.shortName, ...definition.aliases].map((name) =>
      name.toLowerCase().split(/[\s()+-]+/),
    );
    return names.some((parts) =>
      words.every((word) => parts.some((part) => part.startsWith(word))),
    );
  });
}
