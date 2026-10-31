import type { SymbolInfo } from '@tradingnerd/core';

/**
 * Whether a symbol's bars carry real traded volume (docs/SPEC.md §6.16). CRYPTOCAP's market caps
 * carry placeholders (0 or 1, so resampling counts their bars as traded), and a formula its first
 * symbol's; Volume shows none for them rather than those numbers. One place, so a screenshot of
 * TradingView's (SPEC §11) can change it.
 */
export function hasRealVolume(info: SymbolInfo): boolean {
  return info.type !== 'index' && info.type !== 'spread';
}

/** What Volume's legend title names after "Vol ·": the base coin ("XRP"), else the symbol. */
export function volumeUnit(info: SymbolInfo): string {
  return hasRealVolume(info) && info.base ? info.base : info.ticker;
}
