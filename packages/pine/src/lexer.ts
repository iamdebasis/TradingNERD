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

/**
 * The words a version reserves (Pine docs, migration guides): user-defined types, methods,
 * enums, libraries, `for…in` and the qualifier keywords came with v5, so in v4 `type` is a
 * parameter name (`input(type = input.integer)`); `var`, `varip`, `switch` and `while` with v4.
 */
const V5_WORDS = ['import', 'export', 'method', 'type', 'enum', 'const', 'simple', 'series', 'in'];
const V4_WORDS = ['var', 'varip', 'switch', 'while'];

export function keywordsOf(version: number): ReadonlySet<string> {
  if (version >= 5) return KEYWORDS;
  const removed = new Set(version >= 4 ? V5_WORDS : [...V5_WORDS, ...V4_WORDS]);
  return new Set([...KEYWORDS].filter((word) => !removed.has(word)));
}

/** `//@version=N` (spaces tolerated), wherever its line is; null when the script has none. */
export function versionIn(source: string): number | null {
  const match = /^[ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*(\d+)/m.exec(source);
  return match ? Number(match[1]) : null;
}

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

/** Where a joined line's text came from: each piece's start in it, and its line and column. */
interface Piece {
  offset: number;
  line: number;
  column: number;
}

/** Where an offset into a joined line is in the script. */
type Locate = (offset: number) => { line: number; column: number };

function locator(pieces: readonly Piece[]): Locate {
  return (offset) => {
    let piece = pieces[0] as Piece;
    for (const next of pieces) {
      if (next.offset > offset) break;
      piece = next;
    }
    return { line: piece.line, column: piece.column + offset - piece.offset };
  };
}

/** The span of a joined line's text from `start` to `end` (exclusive). */
function spanOf(at: Locate, start: number, end: number): Span {
  const from = at(start);
  const to = at(Math.max(start, end - 1));
  return { line: from.line, column: from.column, endLine: to.line, endColumn: to.column + 1 };
}

/** The multiline string delimiter at `i` (""" or '''), if one starts there. */
function tripleAt(text: string, i: number): string | null {
  const c = text[i];
  if (c !== '"' && c !== "'") return null;
  return text.startsWith(c.repeat(3), i) ? c.repeat(3) : null;
}

/** Where the multiline string opened before `from` closes (after its delimiter), or -1. */
function tripleEnd(text: string, from: number, triple: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text.startsWith(triple, i)) return i + 3;
  }
  return -1;
}

/** The line without its comment, and the comment's text if any. */
function splitComment(
  text: string,
  at: Locate,
  multiline: boolean,
): { code: string; comment: string | null } {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    const triple = tripleAt(text, i);
    if (triple) {
      if (!multiline) {
        throw new PineCompileError(
          `Multiline strings (${triple}…${triple}) need //@version=6`,
          spanOf(at, i, i + 3),
        );
      }
      const end = tripleEnd(text, i + 3, triple);
      // Left open, it's reported where its tokens are read.
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '/' && text[i + 1] === '/') {
      return { code: text.slice(0, i), comment: text.slice(i) };
    }
  }
  return { code: text, comment: null };
}

/** An escape sequence's character: \n, \t and \r, else the character itself (\", \\). */
const escaped = (next: string) =>
  next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;

function readString(code: string, start: number, at: Locate): { value: string; end: number } {
  const quote = code[start] as string;
  let value = '';
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i] as string;
    if (c === quote) return { value, end: i + 1 };
    if (c === '\\' && i + 1 < code.length) {
      value += escaped(code[++i] as string);
    } else {
      value += c;
    }
  }
  throw new PineCompileError('This string has no closing quote', spanOf(at, start, code.length));
}

/**
 * A multiline string (v6, April 2026 release notes): all the code between its delimiters is its
 * text, each line break and every space of indentation included. Escape sequences read as in a
 * one-line string: the notes' own example writes `\\n` to show `\n` (provisional, SPEC §11).
 */
function readMultiline(
  code: string,
  start: number,
  triple: string,
  at: Locate,
): { value: string; end: number } {
  let value = '';
  for (let i = start + 3; i < code.length; i++) {
    if (code.startsWith(triple, i)) return { value, end: i + 3 };
    const c = code[i] as string;
    if (c === '\\' && i + 1 < code.length) value += escaped(code[++i] as string);
    else value += c;
  }
  throw new PineCompileError(
    `This multiline string has no closing ${triple}`,
    spanOf(at, start, start + 3),
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

/** One line's tokens (its code, without the comment). */
function tokenize(
  code: string,
  at: Locate,
  keywords: ReadonlySet<string>,
  multiline: boolean,
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i] as string;
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < code.length && isIdentPart(code[j] as string)) j++;
      const text = code.slice(i, j);
      tokens.push({
        kind: keywords.has(text) ? 'keyword' : 'ident',
        text,
        ...spanOf(at, i, j),
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
        ...spanOf(at, i, i + text.length),
      });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = multiline ? tripleAt(code, i) : null;
      const { value, end } = triple ? readMultiline(code, i, triple, at) : readString(code, i, at);
      tokens.push({
        kind: 'string',
        text: code.slice(i, end),
        value,
        ...spanOf(at, i, end),
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
          spanOf(at, i, Math.max(j, i + 1)),
        );
      }
      const n = (k: number) => Number.parseInt(hex.slice(k, k + 2), 16);
      const alpha = hex.length === 8 ? n(6) : 255;
      tokens.push({
        kind: 'color',
        text: code.slice(i, j),
        value: packColor(n(0), n(2), n(4), 100 * (1 - alpha / 255)),
        ...spanOf(at, i, j),
      });
      i = j;
      continue;
    }
    const op = OPERATORS.find((candidate) => code.startsWith(candidate, i));
    if (op) {
      tokens.push({ kind: 'op', text: op, ...spanOf(at, i, i + op.length) });
      i += op.length;
      continue;
    }
    throw new PineCompileError(`Unexpected character "${c}"`, spanOf(at, i, i + 1));
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

/** A line as the lexer reads it: physical lines joined where a string runs on (below). */
interface SourceLine {
  text: string;
  line: number;
  pieces: Piece[];
}

/**
 * The physical lines, joined where a string runs on. A multiline string (v6) takes its line
 * breaks and indentation into its text. A one-line string left open at a line's end inside
 * brackets goes on at the next line, the line break and the next line's indentation dropped, as
 * TradingView's manual writes a long log message over several lines and its Pine Logs show it on
 * one (Time, Figure 295).
 */
function joinLines(source: string, multiline: boolean): SourceLine[] {
  const out: SourceLine[] = [];
  const physical = source.split(/\r?\n/);
  let depth = 0;
  for (let index = 0; index < physical.length; index++) {
    let text = physical[index] as string;
    const line = index + 1;
    const pieces: Piece[] = [{ offset: 0, line, column: 1 }];
    for (;;) {
      const end = scanLine(text, depth, multiline);
      const more = end.quote !== null && index + 1 < physical.length;
      if (more && end.quote?.length === 3) {
        index++;
        text += '\n';
        pieces.push({ offset: text.length, line: index + 1, column: 1 });
        text += physical[index] as string;
        continue;
      }
      // A string left open runs on into the next line inside brackets, or outside them on a
      // wrapped line (indented by spaces that aren't a multiple of four): the manual's own
      // `BOTTOM_TTIP = "… and then set` / `  the bottom margin …"` (Lines and boxes). The break and
      // the next line's indentation add nothing, as the manual's Pine Logs figure for its wrapped
      // `log.info()` message shows (Time, UNIX timestamps); provisional (docs/SPEC.md §11).
      const wraps = more && (end.depth > 0 || indentOf(physical[index + 1] as string) % 4 !== 0);
      if (!wraps) {
        depth = end.depth;
        break;
      }
      index++;
      const next = physical[index] as string;
      const indent = (/^\s*/.exec(next)?.[0] ?? '').length;
      pieces.push({ offset: text.length, line: index + 1, column: indent + 1 });
      text += next.slice(indent);
    }
    out.push({ text, line, pieces });
    // Lines joined to this one leave blanks, so the next keeps its number.
    while (out.length < index + 1) {
      const blank = out.length + 1;
      out.push({ text: '', line: blank, pieces: [{ offset: 0, line: blank, column: 1 }] });
    }
  }
  return out;
}

/**
 * Where a line leaves its brackets and strings: the open quote, if any (""" or ''' for a
 * multiline string), and the depth.
 */
function scanLine(
  text: string,
  depth: number,
  multiline: boolean,
): { quote: string | null; depth: number } {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    const triple = multiline ? tripleAt(text, i) : null;
    if (triple) {
      const end = tripleEnd(text, i + 3, triple);
      if (end < 0) return { quote: triple, depth };
      i = end - 1;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '/' && text[i + 1] === '/') break;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
  }
  return { quote, depth };
}

/**
 * Splits a script into its logical lines, after comments and Pine's line wrapping. A script with
 * no `//@version` is read as `fallbackVersion` (1, as Pine assumes; tests of v6 code pass 6).
 */
export function lex(source: string, fallbackVersion = 1): Lexed {
  const lines: LogicalLine[] = [];
  const annotations: { line: number; text: string }[] = [];
  const version = versionIn(source);
  const keywords = keywordsOf(version ?? fallbackVersion);
  const multiline = (version ?? fallbackVersion) >= 6;
  let current: LogicalLine | null = null;
  let depth = 0;

  for (const { text, line, pieces } of joinLines(source, multiline)) {
    const at = locator(pieces);
    const { code, comment } = splitComment(text, at, multiline);
    if (comment?.startsWith('//@') && !/^\/\/@version/.test(comment)) {
      annotations.push({ line, text: comment.slice(3) });
    }
    if (code.trim() === '') continue;
    const indent = indentOf(code);
    const tokens = tokenize(code, at, keywords, multiline);
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
  }
  for (const logical of lines) nameQualifiers(logical.tokens);
  return { lines, version, annotations };
}

/** The qualifier words, which only qualify a type that follows them. */
const QUALIFIER_WORDS = new Set(['const', 'simple', 'series']);

/**
 * `const`, `simple` and `series` qualify a type only when one follows (`series float x`); else
 * they're names, as TradingView's manual uses them: `series = close >= open ? close : na` (FAQ,
 * "Query the last non-na value") and `pine_alma(series, windowsize, …)` (ta.alma's reference).
 */
function nameQualifiers(tokens: Token[]): void {
  tokens.forEach((token, i) => {
    if (token.kind !== 'keyword' || !QUALIFIER_WORDS.has(token.text)) return;
    const next = tokens[i + 1];
    if (next?.kind !== 'ident') token.kind = 'ident';
  });
}
