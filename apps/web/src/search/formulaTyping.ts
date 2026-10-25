import { type Formula, parseFormula } from '@tradingnerd/core';

/**
 * Formulas typed in the symbol search, as TradingView reads them (Symbol Search tips,
 * docs/SPEC.md §5.11): symbols combined with + − * / and brackets. The list searches for the
 * symbol being typed, the last one, and a pick fills it in.
 */

/** The symbol being typed in a formula, and where it starts in the text. */
export interface Operand {
  /** "ETH" in "BTCUSDT / ETH"; empty right after an operator. */
  text: string;
  start: number;
}

/**
 * Whether what's typed is plainly a formula: + * or brackets, or a / or − with a space beside it
 * (TradingView's "operator followed by a space"), or before a number or another exchange's
 * symbol. "XRP/USDT", "BTC-USD" and "NYSE:JPM/PD" stay searches; such text is a formula only
 * when no symbol matches it.
 */
export function looksLikeFormula(text: string): boolean {
  const typed = text.trim();
  if (/[+*()]/.test(typed)) return true;
  return /\s[-/]|[-/]\s|[-/](?:\.?\d|[A-Za-z][A-Za-z0-9_]*:)/.test(typed);
}

/** The symbol being typed: the formula's last, after its last operator or bracket. */
export function lastOperand(text: string): Operand {
  const match = /([A-Za-z0-9._:]*)\s*$/.exec(text);
  const operand = match?.[1] ?? '';
  // Right after an operator, the symbol starts where the typing is, after any space typed.
  return { text: operand, start: operand === '' ? text.length : (match?.index ?? text.length) };
}

/** The text with the symbol being typed replaced by the one picked. */
export function fillOperand(text: string, operand: Operand, symbol: string): string {
  return `${text.slice(0, operand.start)}${symbol}`;
}

/**
 * What's typed, read as a formula: as written, or with its / and − taken as operators where the
 * whole reads as one symbol ("BINANCE:BTCUSDT/ETH", as NYSE:JPM/PD does). For text no symbol
 * matches.
 */
export function readFormula(text: string): Formula | null {
  return parseFormula(text) ?? parseFormula(text.replace(/[-/]/g, ' $& '));
}
