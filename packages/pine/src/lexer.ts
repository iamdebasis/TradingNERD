import { PineCompileError, type Span } from './diagnostics.ts';

/**
 * Pine's words and symbols. Keywords are reserved; `na`, `true` and `false` are values the
 * parser reads (the Pine v6 reference lists them as built-in constants and literals).
 */
export type TokenKind = 'ident' | 'keyword' | 'int' | 'float' | 'string' | 'color' | 'op';

export interface Token extends Span {
  kind: TokenKind;
  text: string;
  /** A number's value, a string's text without quotes and escapes, a color's packed value. */
  value?: number | string;
}

/**
 * One statement's line, after Pine's line wrapping: a line indented by spaces that aren't a
 * multiple of four continues the line before (Pine docs, Line wrapping); so do lines inside
 * open brackets, and after an operator that can't end a line (lenient, where TradingView's
 * compiler would ask for the odd indentation).
 */
export interface LogicalLine {
  /** Its indentation in spaces (a tab counts four): four per block level. */
  indent: number;
  tokens: Token[];
  /** Its first physical line. */
  line: number;
}

export interface Lexed {
  lines: LogicalLine[];
  /** From `//@version=N`; null when the script doesn't say (Pine then assumes 1). */
  version: number | null;
  /** `//@function`, `//@param`, `//@variable` and the like, by line, for the editor's help. */
  annotations: { line: number; text: string }[];
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  'and',
  'or',
  'not',
  'if',
  'else',
  'for',
  'to',
  'by',
  'in',
  'while',
  'switch',
  'var',
  'varip',
  'break',
  'continue',
  'import',
  'export',
  'method',
  'type',
  'enum',
  'const',
  'simple',
  'series',
]);

/** Longest first, so `:=` wins over `:`. */
const OPERATORS = [
  ':=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '==',
  '!=',
  '<=',
  '>=',
  '=>',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '?',
  ':',
  '(',
  ')',
  '[',
  ']',
  ',',
  '.',
] as const;

/** Operators a line can't end on: the next line continues it. */
const DANGLING = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '?',
  ':',
  ',',
  '=',
  ':=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  'and',
  'or',
  'not',
]);

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';
const isHex = (c: string) => /[0-9A-Fa-f]/.test(c);

/** A color literal's value: red, green, blue and Pine's transparency (0 opaque … 100 clear). */
export function packColor(r: number, g: number, b: number, transparency: number): number {
  const t = Math.round(Math.min(100, Math.max(0, transparency)) * 2);
  return ((r & 255) * 16777216 + (g & 255) * 65536 + (b & 255) * 256 + t) as number;
}

const span = (line: number, column: number, endColumn: number): Span => ({
  line,
  column,
  endLine: line,
  endColumn,
});

/** The physical line without its comment, and the comment's text if any. */
function splitComment(text: string, line: number): { code: string; comment: string | null } {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (text.startsWith(c.repeat(3), i)) {
        throw new PineCompileError(
          "Multiline strings aren't supported yet",
          span(line, i + 1, i + 4),
        );
      }
      quote = c;
    } else if (c === '/' && text[i + 1] === '/') {
      return { code: text.slice(0, i), comment: text.slice(i) };
    }
  }
  return { code: text, comment: null };
}

function readString(code: string, start: number, line: number): { value: string; end: number } {
  const quote = code[start] as string;
  let value = '';
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i] as string;
    if (c === quote) return { value, end: i + 1 };
    if (c === '\\' && i + 1 < code.length) {
      const next = code[++i] as string;
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
    } else {
      value += c;
    }
  }
  throw new PineCompileError(
    'This string has no closing quote',
    span(line, start + 1, code.length + 1),
  );
}

function readNumber(code: string, start: number): { text: string; float: boolean } {
  let i = start;
  let float = false;
  while (i < code.length && isDigit(code[i] as string)) i++;
  if (code[i] === '.' && !(i + 1 < code.length && isIdentStart(code[i + 1] as string))) {
    float = true;
    i++;
    while (i < code.length && isDigit(code[i] as string)) i++;
  }
  if (code[i] === 'e' || code[i] === 'E') {
    const sign = code[i + 1] === '+' || code[i + 1] === '-' ? 1 : 0;
    if (isDigit((code[i + 1 + sign] ?? '') as string)) {
      float = true;
      i += 1 + sign;
      while (i < code.length && isDigit(code[i] as string)) i++;
    }
  }
  return { text: code.slice(start, i), float };
}

/** One physical line's tokens (its code, without the comment). */
function tokenize(code: string, line: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i] as string;
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    const column = i + 1;
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < code.length && isIdentPart(code[j] as string)) j++;
      const text = code.slice(i, j);
      tokens.push({
        kind: KEYWORDS.has(text) ? 'keyword' : 'ident',
        text,
        ...span(line, column, j + 1),
      });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit((code[i + 1] ?? '') as string))) {
      const { text, float } = readNumber(code, i);
      tokens.push({
        kind: float ? 'float' : 'int',
        text,
        value: Number(text),
        ...span(line, column, i + text.length + 1),
      });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      const { value, end } = readString(code, i, line);
      tokens.push({
        kind: 'string',
        text: code.slice(i, end),
        value,
        ...span(line, column, end + 1),
      });
      i = end;
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < code.length && isHex(code[j] as string)) j++;
      const hex = code.slice(i + 1, j);
      if (
        (hex.length !== 6 && hex.length !== 8) ||
        (j < code.length && isIdentPart(code[j] as string))
      ) {
        throw new PineCompileError(
          `"${code.slice(i, Math.max(j, i + 1))}" isn't a color: write #RRGGBB or #RRGGBBAA`,
          span(line, column, j + 1),
        );
      }
      const n = (k: number) => Number.parseInt(hex.slice(k, k + 2), 16);
      const alpha = hex.length === 8 ? n(6) : 255;
      tokens.push({
        kind: 'color',
        text: code.slice(i, j),
        value: packColor(n(0), n(2), n(4), 100 * (1 - alpha / 255)),
        ...span(line, column, j + 1),
      });
      i = j;
      continue;
    }
    const op = OPERATORS.find((candidate) => code.startsWith(candidate, i));
    if (op) {
      tokens.push({ kind: 'op', text: op, ...span(line, column, column + op.length) });
      i += op.length;
      continue;
    }
    throw new PineCompileError(`Unexpected character "${c}"`, span(line, column, column + 1));
  }
  return tokens;
}

/** Leading whitespace in spaces, a tab counting four. */
function indentOf(text: string): number {
  let spaces = 0;
  for (const c of text) {
    if (c === ' ') spaces++;
    else if (c === '\t') spaces += 4;
    else break;
  }
  return spaces;
}

/** Splits a script into its logical lines, after comments and Pine's line wrapping. */
export function lex(source: string): Lexed {
  const physical = source.split(/\r?\n/);
  const lines: LogicalLine[] = [];
  const annotations: { line: number; text: string }[] = [];
  let version: number | null = null;
  let current: LogicalLine | null = null;
  let depth = 0;

  physical.forEach((text, index) => {
    const line = index + 1;
    const { code, comment } = splitComment(text, line);
    if (comment?.startsWith('//@')) {
      const match = /^\/\/@version\s*=\s*(\d+)/.exec(comment);
      if (match) version = Number(match[1]);
      else annotations.push({ line, text: comment.slice(3) });
    }
    if (code.trim() === '') return;
    const indent = indentOf(code);
    const tokens = tokenize(code, line);
    const last = current?.tokens.at(-1);
    const continues =
      current !== null &&
      (depth > 0 ||
        indent % 4 !== 0 ||
        (last !== undefined &&
          (last.kind === 'op' || last.kind === 'keyword') &&
          DANGLING.has(last.text)));
    if (continues && current) {
      current.tokens.push(...tokens);
    } else {
      if (indent % 4 !== 0) {
        throw new PineCompileError(
          'A wrapped line needs a line before it to continue',
          span(line, 1, indent + 1),
        );
      }
      current = { indent, tokens, line };
      lines.push(current);
      depth = 0;
    }
    for (const token of tokens) {
      if (token.kind !== 'op') continue;
      if (token.text === '(' || token.text === '[') depth++;
      else if (token.text === ')' || token.text === ']') depth = Math.max(0, depth - 1);
    }
  });
  return { lines, version, annotations };
}
