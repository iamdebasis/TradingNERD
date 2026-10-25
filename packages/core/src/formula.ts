import { parseSymbolId, type SymbolId } from './market.ts';

/**
 * Formulas, TradingView's spreads (docs/SPEC.md §4.12): symbols and numbers joined by + − * /,
 * like CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD, BINANCE:BTCUSDT*2 or (A+B)/2. Precedence and
 * parentheses as in arithmetic; at most 10 different symbols.
 */

/** TradingView's limit: "no more than 10 unique symbols". */
export const MAX_FORMULA_SYMBOLS = 10;
/** The longest formula we keep (in watchlists and messages too). */
export const MAX_FORMULA_LENGTH = 256;

export type FormulaOperator = '+' | '-' | '*' | '/';

export type FormulaNode =
  | { kind: 'number'; value: number }
  /** "BINANCE:XRPUSDT", or a ticker without its exchange ("XRPUSD") while typing. */
  | { kind: 'symbol'; symbol: string }
  | { kind: 'negate'; operand: FormulaNode }
  | { kind: 'binary'; operator: FormulaOperator; left: FormulaNode; right: FormulaNode };

export interface Formula {
  root: FormulaNode;
  /** Its symbols, each once, in the order they first appear. */
  symbols: string[];
  /** As TradingView saves it: no spaces, the exchanges kept ("CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD"). */
  text: SymbolId;
  /** As TradingView shows it: the tickers alone ("TOTAL2/XRPUSD"). */
  name: string;
}

type Token =
  | { type: 'operator'; operator: FormulaOperator }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'number'; value: number }
  | { type: 'symbol'; symbol: string };

const OPERATORS = new Set(['+', '-', '*', '/']);
/** What a symbol or a number is made of, in a formula: "/" and "-" there are operators. */
const OPERAND_CHAR = /[A-Za-z0-9._!&:]/;
const NUMBER = /^(\d+(\.\d*)?|\.\d+)$/;
const EXCHANGE = /^[A-Z][A-Z0-9_]{0,31}$/;
const TICKER = /^[A-Z0-9][A-Z0-9._!&]{0,47}$/;

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] as string;
    if (/\s/.test(char)) {
      at++;
    } else if (OPERATORS.has(char)) {
      tokens.push({ type: 'operator', operator: char as FormulaOperator });
      at++;
    } else if (char === '(' || char === ')') {
      tokens.push({ type: char === '(' ? 'open' : 'close' });
      at++;
    } else if (OPERAND_CHAR.test(char)) {
      let end = at;
      while (end < text.length && OPERAND_CHAR.test(text[end] as string)) end++;
      const operand = operandOf(text.slice(at, end));
      if (!operand) return null;
      tokens.push(operand);
      at = end;
    } else {
      return null;
    }
  }
  return tokens;
}

function operandOf(raw: string): Token | null {
  if (NUMBER.test(raw)) {
    const value = Number(raw);
    return Number.isFinite(value) ? { type: 'number', value } : null;
  }
  const text = raw.toUpperCase();
  const colon = text.indexOf(':');
  if (colon < 0) return TICKER.test(text) ? { type: 'symbol', symbol: text } : null;
  const exchange = text.slice(0, colon);
  const ticker = text.slice(colon + 1);
  if (!EXCHANGE.test(exchange) || !TICKER.test(ticker)) return null;
  return { type: 'symbol', symbol: `${exchange}:${ticker}` };
}

/** Recursive descent: expression = term (± term)*; term = factor (×÷ factor)*. */
function parseTokens(tokens: readonly Token[]): FormulaNode | null {
  let at = 0;
  const peek = () => tokens[at];

  const factor = (): FormulaNode | null => {
    const token = peek();
    if (!token) return null;
    if (token.type === 'operator' && token.operator === '-') {
      at++;
      const operand = factor();
      return operand ? { kind: 'negate', operand } : null;
    }
    if (token.type === 'number') {
      at++;
      return { kind: 'number', value: token.value };
    }
    if (token.type === 'symbol') {
      at++;
      return { kind: 'symbol', symbol: token.symbol };
    }
    if (token.type === 'open') {
      at++;
      const inner = expression();
      if (!inner || peek()?.type !== 'close') return null;
      at++;
      return inner;
    }
    return null;
  };

  const chain = (next: () => FormulaNode | null, operators: string): FormulaNode | null => {
    let left = next();
    while (left) {
      const token = peek();
      if (token?.type !== 'operator' || !operators.includes(token.operator)) break;
      at++;
      const right = next();
      if (!right) return null;
      left = { kind: 'binary', operator: token.operator, left, right };
    }
    return left;
  };

  const term = () => chain(factor, '*/');
  const expression = (): FormulaNode | null => chain(term, '+-');

  const root = expression();
  return root && at === tokens.length ? root : null;
}

const PRECEDENCE: Readonly<Record<FormulaOperator, number>> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/** A number as written in a formula: "2", "1.5", "0.001". */
const numberText = (value: number) => String(value);

/** A formula's text, parentheses only where they're needed. */
function write(node: FormulaNode, symbol: (symbol: string) => string): string {
  switch (node.kind) {
    case 'number':
      return numberText(node.value);
    case 'symbol':
      return symbol(node.symbol);
    case 'negate': {
      const inner = write(node.operand, symbol);
      return node.operand.kind === 'binary' ? `-(${inner})` : `-${inner}`;
    }
    case 'binary': {
      const level = PRECEDENCE[node.operator];
      const lower = (child: FormulaNode) =>
        child.kind === 'binary' && PRECEDENCE[child.operator] < level;
      const left = write(node.left, symbol);
      const right = write(node.right, symbol);
      // a-(b-c) and a/(b*c) keep theirs; so does a minus or a negative on the right.
      const rightNeeds =
        lower(node.right) ||
        node.right.kind === 'negate' ||
        (node.right.kind === 'binary' &&
          PRECEDENCE[node.right.operator] === level &&
          (node.operator === '-' || node.operator === '/'));
      return `${lower(node.left) ? `(${left})` : left}${node.operator}${rightNeeds ? `(${right})` : right}`;
    }
  }
}

function symbolsOf(node: FormulaNode, out: string[]): string[] {
  switch (node.kind) {
    case 'symbol':
      if (!out.includes(node.symbol)) out.push(node.symbol);
      break;
    case 'negate':
      symbolsOf(node.operand, out);
      break;
    case 'binary':
      symbolsOf(node.left, out);
      symbolsOf(node.right, out);
      break;
    case 'number':
      break;
  }
  return out;
}

/** A symbol's ticker without its exchange: "BITSTAMP:XRPUSD" → "XRPUSD". */
const tickerOf = (symbol: string) => symbol.slice(symbol.indexOf(':') + 1);

/**
 * Reads a formula; null for text that isn't one: a lone symbol or number, broken syntax, more
 * than 10 symbols, or over 256 characters. A symbol id with a "/" or "-" in its ticker (NYSE's
 * JPM/PD, a preferred share) stays a symbol unless a number follows the operator
 * (BINANCE:BTCUSDT/2); inside a formula, "/" and "-" are always operators.
 */
export function parseFormula(text: string): Formula | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FORMULA_LENGTH) return null;
  const tokens = tokenize(trimmed);
  if (!tokens?.some((token) => token.type === 'operator')) return null;
  const plain = parseSymbolId(trimmed);
  if (plain && !/[\s()+*]/.test(trimmed) && !tokens.some((token) => token.type === 'number')) {
    return null;
  }
  const root = parseTokens(tokens);
  if (!root || root.kind === 'symbol' || root.kind === 'number') return null;
  const symbols = symbolsOf(root, []);
  if (symbols.length === 0 || symbols.length > MAX_FORMULA_SYMBOLS) return null;
  return {
    root,
    symbols,
    text: write(root, (symbol) => symbol),
    name: write(root, tickerOf),
  };
}

/** A formula with its symbols replaced: bare tickers by their listings, one symbol by another. */
export function replaceSymbols(formula: Formula, replace: (symbol: string) => string): Formula {
  const swap = (node: FormulaNode): FormulaNode => {
    switch (node.kind) {
      case 'symbol':
        return { kind: 'symbol', symbol: replace(node.symbol) };
      case 'negate':
        return { kind: 'negate', operand: swap(node.operand) };
      case 'binary':
        return { ...node, left: swap(node.left), right: swap(node.right) };
      case 'number':
        return node;
    }
  };
  const root = swap(formula.root);
  return {
    root,
    symbols: symbolsOf(root, []),
    text: write(root, (symbol) => symbol),
    name: write(root, tickerOf),
  };
}

/**
 * A formula's value from its symbols' values; NaN where it has none (a division by zero, or a
 * symbol without a value).
 */
export function evaluateFormula(node: FormulaNode, priceOf: (symbol: string) => number): number {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'symbol':
      return priceOf(node.symbol);
    case 'negate':
      return -evaluateFormula(node.operand, priceOf);
    case 'binary': {
      const left = evaluateFormula(node.left, priceOf);
      const right = evaluateFormula(node.right, priceOf);
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return right === 0 ? Number.NaN : left / right;
      }
    }
  }
}

/** Whether every symbol of a formula has its exchange (as saved formulas do). */
export function isComplete(formula: Formula): boolean {
  return formula.symbols.every((symbol) => parseSymbolId(symbol) !== null);
}

/**
 * Whether the gateway charts `text`: an exchange's symbol (BINANCE:XRPUSDT), or a formula each of
 * whose symbols has its exchange.
 */
export function isChartable(text: string): boolean {
  if (parseSymbolId(text)) return true;
  const formula = parseFormula(text);
  return formula !== null && isComplete(formula);
}

/**
 * How a symbol is shown in the watchlist, the symbol pill and menus: its ticker
 * ("BINANCE:XRPUSDT" → "XRPUSDT"), and a formula without its exchanges ("TOTAL2/XRPUSD").
 */
export function symbolName(symbol: SymbolId): string {
  return parseFormula(symbol)?.name ?? tickerOf(symbol);
}
