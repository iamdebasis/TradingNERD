import {
  type AssignOp,
  type Block,
  type Expr,
  type Param,
  type QualifierWord,
  type Script,
  type Stmt,
  TYPE_NAMES,
  type TypeName,
} from './ast.ts';
import { PineCompileError, type Span, spanOf } from './diagnostics.ts';
import { type LogicalLine, lex, type Token } from './lexer.ts';

const ASSIGN_OPS: ReadonlySet<string> = new Set([':=', '+=', '-=', '*=', '/=', '%=']);
const QUALIFIERS: ReadonlySet<string> = new Set(['const', 'simple', 'series']);
const STRUCTURES: ReadonlySet<string> = new Set(['if', 'switch', 'for', 'while']);
const isTypeName = (text: string): text is TypeName =>
  (TYPE_NAMES as readonly string[]).includes(text);

/** Pine features this engine doesn't have yet, with the milestone that brings them. */
const NOT_YET: Readonly<Record<string, string>> = {
  import: 'Libraries (import) come later (P3)',
  export: 'Libraries (export) come later (P3)',
  method: 'Methods come later (P2)',
  type: 'User-defined types come later (P2)',
  enum: 'Enums come later (P2)',
};

/** The tokens of one logical line, read left to right. */
class Tokens {
  private readonly tokens: readonly Token[];
  private index: number;
  /** Where the line ends, for errors about something missing at its end. */
  readonly endSpan: Span;

  constructor(tokens: readonly Token[], line: LogicalLine, start = 0) {
    this.tokens = tokens;
    this.index = start;
    const last = line.tokens.at(-1);
    this.endSpan = last
      ? {
          line: last.endLine,
          column: last.endColumn,
          endLine: last.endLine,
          endColumn: last.endColumn + 1,
        }
      : { line: line.line, column: 1, endLine: line.line, endColumn: 2 };
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new PineCompileError('This line ends too soon', this.endSpan);
    this.index++;
    return token;
  }

  get position(): number {
    return this.index;
  }

  /** The token is this operator or keyword. */
  is(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return (
      token !== undefined &&
      (token.kind === 'op' || token.kind === 'keyword') &&
      token.text === text
    );
  }

  accept(text: string): Token | null {
    if (!this.is(text)) return null;
    return this.next();
  }

  expect(text: string, what = `"${text}"`): Token {
    const token = this.peek();
    if (!this.is(text)) {
      throw new PineCompileError(
        token
          ? `Syntax error at "${token.text}": expected ${what}`
          : `Expected ${what} at the end of the line`,
        token ?? this.endSpan,
      );
    }
    return this.next();
  }

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  expectEnd(): void {
    const token = this.peek();
    if (token)
      throw new PineCompileError(`Syntax error at "${token.text}": unexpected text`, token);
  }

  /** The rest of the line's tokens, consumed. */
  rest(): Token[] {
    const rest = this.tokens.slice(this.index);
    this.index = this.tokens.length;
    return [...rest];
  }

  /** How far ahead the bracket closing the one `offset` tokens ahead is, or -1. */
  closing(offset: number): number {
    let depth = 0;
    for (let i = this.index + offset; i < this.tokens.length; i++) {
      const token = this.tokens[i] as Token;
      if (token.kind !== 'op') continue;
      if (token.text === '(' || token.text === '[') depth++;
      else if (token.text === ')' || token.text === ']') {
        depth--;
        if (depth === 0) return i - this.index;
      }
    }
    return -1;
  }

  /** `name(…) =>`: a function's declaration starts here. */
  startsFunction(): boolean {
    if (this.peek()?.kind !== 'ident' || !this.is('(', 1)) return false;
    const close = this.closing(1);
    return close > 0 && this.is('=>', close + 1);
  }
}

/** Splits a line's tokens at its commas outside brackets: several statements on one line. */
function splitStatements(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'op') {
      if (token.text === '(' || token.text === '[') depth++;
      else if (token.text === ')' || token.text === ']') depth--;
      else if (token.text === ',' && depth === 0) {
        parts.push([]);
        continue;
      }
    }
    (parts.at(-1) as Token[]).push(token);
  }
  return parts.filter((part) => part.length > 0);
}

class Parser {
  private readonly lines: readonly LogicalLine[];
  private index = 0;

  constructor(lines: readonly LogicalLine[]) {
    this.lines = lines;
  }

  script(): Stmt[] {
    return this.statements(0, true);
  }

  /** The statements of lines at `indent`, until a line indented less. */
  private statements(indent: number, global: boolean): Stmt[] {
    const out: Stmt[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index] as LogicalLine;
      if (line.indent < indent) break;
      const first = line.tokens[0] as Token;
      if (line.indent > indent) {
        throw new PineCompileError(
          'Unexpected indentation: only the lines of a block (after if, for, while, switch or a function) are indented',
          first,
        );
      }
      this.index++;
      out.push(...this.lineStatements(line, global));
    }
    return out;
  }

  /** The block of lines indented one level under the line just read. */
  private block(indent: number, after: Span): Block {
    const next = this.lines[this.index];
    if (!next || next.indent < indent) {
      throw new PineCompileError('Expected an indented block on the next line', after);
    }
    const statements = this.statements(indent, false);
    const first = statements[0]?.span ?? after;
    const last = statements.at(-1)?.span ?? after;
    return { statements, span: spanOf(first, last) };
  }

  private lineStatements(line: LogicalLine, global: boolean): Stmt[] {
    const first = line.tokens[0] as Token;
    if (first.kind === 'keyword' && NOT_YET[first.text]) {
      throw new PineCompileError(NOT_YET[first.text] as string, first);
    }
    // A structure or a function owns the lines under it: nothing else shares its line.
    const whole = new Tokens(line.tokens, line);
    if ((first.kind === 'keyword' && STRUCTURES.has(first.text)) || whole.startsFunction()) {
      return [this.statement(whole, line, global)];
    }
    return splitStatements(line.tokens).map((tokens) =>
      this.statement(new Tokens(tokens, line), line, global),
    );
  }

  private statement(tokens: Tokens, line: LogicalLine, global: boolean): Stmt {
    const first = tokens.peek() as Token;
    if (first.kind === 'keyword') {
      if (STRUCTURES.has(first.text)) {
        const expr = this.structure(tokens, line);
        return { kind: 'expr', expr, span: expr.span };
      }
      if (first.text === 'break' || first.text === 'continue') {
        tokens.next();
        tokens.expectEnd();
        return { kind: first.text, span: first };
      }
    }
    if (tokens.startsFunction()) {
      if (!global) {
        throw new PineCompileError('Functions can only be declared in the global scope', first);
      }
      return this.func(tokens, line);
    }
    if (first.kind === 'op' && first.text === '[') {
      const close = tokens.closing(0);
      if (close > 0 && tokens.is('=', close + 1)) return this.tupleDecl(tokens, line);
    }
    if (this.isDeclaration(tokens)) return this.declaration(tokens, line);
    if (first.kind === 'ident' && ASSIGN_OPS.has(tokens.peek(1)?.text ?? '')) {
      const name = tokens.next();
      const op = tokens.next().text as AssignOp;
      const value = this.rhs(tokens, line);
      return {
        kind: 'assign',
        op,
        name: name.text,
        nameSpan: name,
        value,
        span: spanOf(name, value.span),
      };
    }
    const expr = this.expression(tokens);
    tokens.expectEnd();
    return { kind: 'expr', expr, span: expr.span };
  }

  private isDeclaration(tokens: Tokens): boolean {
    let i = 0;
    if (tokens.is('var') || tokens.is('varip')) i++;
    if (tokens.peek(i)?.kind === 'keyword' && QUALIFIERS.has(tokens.peek(i)?.text ?? '')) i++;
    const a = tokens.peek(i);
    const b = tokens.peek(i + 1);
    if (a?.kind !== 'ident') return false;
    if (b?.kind === 'op' && b.text === '=') return true;
    // array<float> x = …: a declaration, refused below as not yet supported.
    if (tokens.is('<', i + 1) && tokens.is('>', i + 3) && tokens.peek(i + 4)?.kind === 'ident')
      return true;
    return b?.kind === 'ident' && tokens.is('=', i + 2);
  }

  private declaration(tokens: Tokens, line: LogicalLine): Stmt {
    const start = tokens.peek() as Token;
    const mode = tokens.accept('var') ? 'var' : tokens.accept('varip') ? 'varip' : null;
    const qualifierToken = tokens.peek();
    let qualifier: QualifierWord | null = null;
    if (qualifierToken?.kind === 'keyword' && QUALIFIERS.has(qualifierToken.text)) {
      qualifier = tokens.next().text as QualifierWord;
    }
    let type: TypeName | null = null;
    if (tokens.peek(1)?.kind === 'op' && tokens.peek(1)?.text === '<') {
      throw new PineCompileError(
        'Arrays, matrices and maps come later (P2)',
        tokens.peek() as Token,
      );
    }
    if (tokens.peek(1)?.kind === 'ident') {
      const typeToken = tokens.next();
      if (!isTypeName(typeToken.text)) {
        throw new PineCompileError(
          `"${typeToken.text}" isn't a type we know: int, float, bool, color or string`,
          typeToken,
        );
      }
      type = typeToken.text;
    }
    const name = tokens.next();
    if (name.kind !== 'ident') throw new PineCompileError(`"${name.text}" can't be a name`, name);
    tokens.expect('=');
    const value = this.rhs(tokens, line);
    return {
      kind: 'decl',
      mode,
      qualifier,
      type,
      name: name.text,
      nameSpan: name,
      value,
      span: spanOf(start, value.span),
    };
  }

  private tupleDecl(tokens: Tokens, line: LogicalLine): Stmt {
    const open = tokens.next();
    const names: string[] = [];
    const nameSpans: Span[] = [];
    do {
      const name = tokens.next();
      if (name.kind !== 'ident') throw new PineCompileError(`"${name.text}" can't be a name`, name);
      names.push(name.text);
      nameSpans.push(name);
    } while (tokens.accept(','));
    tokens.expect(']');
    tokens.expect('=');
    const value = this.rhs(tokens, line);
    return { kind: 'tupleDecl', names, nameSpans, value, span: spanOf(open, value.span) };
  }

  /** What a declaration or an assignment gives: an expression, or a structure on this line. */
  private rhs(tokens: Tokens, line: LogicalLine): Expr {
    const first = tokens.peek();
    if (first?.kind === 'keyword' && STRUCTURES.has(first.text))
      return this.structure(tokens, line);
    const value = this.expression(tokens);
    tokens.expectEnd();
    return value;
  }

  private func(tokens: Tokens, line: LogicalLine): Stmt {
    const name = tokens.next();
    tokens.expect('(');
    const params: Param[] = [];
    if (!tokens.is(')')) {
      do {
        params.push(this.param(tokens));
      } while (tokens.accept(','));
    }
    tokens.expect(')');
    const arrow = tokens.expect('=>');
    let body: Block;
    if (tokens.atEnd()) {
      body = this.block(line.indent + 4, arrow);
    } else {
      const rest = new Tokens(tokens.rest(), line);
      const statement = this.statement(rest, line, false);
      body = { statements: [statement], span: statement.span };
    }
    return {
      kind: 'func',
      name: name.text,
      nameSpan: name,
      params,
      body,
      span: spanOf(name, body.span),
    };
  }

  private param(tokens: Tokens): Param {
    const start = tokens.peek() as Token;
    let qualifier: QualifierWord | null = null;
    if (start.kind === 'keyword' && QUALIFIERS.has(start.text)) {
      qualifier = tokens.next().text as QualifierWord;
    }
    let type: TypeName | null = null;
    if (tokens.peek(1)?.kind === 'ident') {
      const typeToken = tokens.next();
      if (!isTypeName(typeToken.text)) {
        throw new PineCompileError(
          `"${typeToken.text}" isn't a type we know: int, float, bool, color or string`,
          typeToken,
        );
      }
      type = typeToken.text;
    }
    const name = tokens.next();
    if (name.kind !== 'ident')
      throw new PineCompileError(`"${name.text}" can't be a parameter`, name);
    const fallback = tokens.accept('=') ? this.expression(tokens) : null;
    return {
      name: name.text,
      type,
      qualifier,
      default: fallback,
      span: spanOf(start, fallback?.span ?? name),
    };
  }

  private structure(tokens: Tokens, line: LogicalLine): Expr {
    const keyword = tokens.next();
    switch (keyword.text) {
      case 'if':
        return this.ifStructure(tokens, line, keyword);
      case 'switch':
        return this.switchStructure(tokens, line, keyword);
      case 'for':
        return this.forStructure(tokens, line, keyword);
      default:
        return this.whileStructure(tokens, line, keyword);
    }
  }

  private ifStructure(tokens: Tokens, line: LogicalLine, keyword: Token): Expr {
    const branches: { cond: Expr; body: Block }[] = [];
    let cond = this.expression(tokens);
    tokens.expectEnd();
    branches.push({ cond, body: this.block(line.indent + 4, cond.span) });
    let otherwise: Block | null = null;
    while (this.index < this.lines.length) {
      const next = this.lines[this.index] as LogicalLine;
      const elseToken = next.tokens[0] as Token;
      if (next.indent !== line.indent || elseToken.kind !== 'keyword' || elseToken.text !== 'else')
        break;
      this.index++;
      const rest = new Tokens(next.tokens, next, 1);
      if (rest.accept('if')) {
        cond = this.expression(rest);
        rest.expectEnd();
        branches.push({ cond, body: this.block(line.indent + 4, cond.span) });
        continue;
      }
      rest.expectEnd();
      otherwise = this.block(line.indent + 4, elseToken);
      break;
    }
    const end = otherwise?.span ?? (branches.at(-1) as { body: Block }).body.span;
    return { kind: 'if', branches, otherwise, span: spanOf(keyword, end) };
  }

  private switchStructure(tokens: Tokens, line: LogicalLine, keyword: Token): Expr {
    const subject = tokens.atEnd() ? null : this.expression(tokens);
    tokens.expectEnd();
    const cases: { match: Expr | null; body: Block }[] = [];
    const caseIndent = line.indent + 4;
    while (this.index < this.lines.length) {
      const next = this.lines[this.index] as LogicalLine;
      if (next.indent !== caseIndent) break;
      this.index++;
      const caseTokens = new Tokens(next.tokens, next);
      let match: Expr | null = null;
      if (!caseTokens.is('=>')) match = this.expression(caseTokens);
      const arrow = caseTokens.expect('=>', '"=>" after the case');
      let body: Block;
      if (caseTokens.atEnd()) {
        body = this.block(caseIndent + 4, arrow);
      } else {
        const statement = this.statement(new Tokens(caseTokens.rest(), next), next, false);
        body = { statements: [statement], span: statement.span };
      }
      cases.push({ match, body });
    }
    if (cases.length === 0) throw new PineCompileError('A switch needs at least one case', keyword);
    return {
      kind: 'switch',
      subject,
      cases,
      span: spanOf(keyword, (cases.at(-1) as { body: Block }).body.span),
    };
  }

  private forStructure(tokens: Tokens, line: LogicalLine, keyword: Token): Expr {
    const counter = tokens.next();
    if (counter.kind !== 'ident')
      throw new PineCompileError(`"${counter.text}" can't be a counter`, counter);
    if (tokens.is('in') || tokens.is(',')) {
      throw new PineCompileError('for…in loops come later, with arrays (P2)', counter);
    }
    tokens.expect('=');
    const from = this.expression(tokens);
    tokens.expect('to', '"to"');
    const to = this.expression(tokens);
    const step = tokens.accept('by') ? this.expression(tokens) : null;
    tokens.expectEnd();
    const body = this.block(line.indent + 4, (step ?? to).span);
    return {
      kind: 'for',
      counter: counter.text,
      counterSpan: counter,
      from,
      to,
      step,
      body,
      span: spanOf(keyword, body.span),
    };
  }

  private whileStructure(tokens: Tokens, line: LogicalLine, keyword: Token): Expr {
    const cond = this.expression(tokens);
    tokens.expectEnd();
    const body = this.block(line.indent + 4, cond.span);
    return { kind: 'while', cond, body, span: spanOf(keyword, body.span) };
  }

  // ---- expressions, by Pine's precedence (Pine docs, Operator precedence) ----

  expression(tokens: Tokens): Expr {
    const cond = this.or(tokens);
    if (!tokens.accept('?')) return cond;
    const then = this.expression(tokens);
    tokens.expect(':', '":" in the ?: expression');
    const otherwise = this.expression(tokens);
    return { kind: 'ternary', cond, then, otherwise, span: spanOf(cond.span, otherwise.span) };
  }

  private binaryLevel(tokens: Tokens, ops: readonly string[], next: (t: Tokens) => Expr): Expr {
    let left = next(tokens);
    for (;;) {
      const op = ops.find((candidate) => tokens.is(candidate));
      if (!op) return left;
      tokens.next();
      const right = next(tokens);
      left = { kind: 'binary', op, left, right, span: spanOf(left.span, right.span) };
    }
  }

  private or(tokens: Tokens): Expr {
    return this.binaryLevel(tokens, ['or'], (t) => this.and(t));
  }

  private and(tokens: Tokens): Expr {
    return this.binaryLevel(tokens, ['and'], (t) => this.equality(t));
  }

  private equality(tokens: Tokens): Expr {
    return this.binaryLevel(tokens, ['==', '!='], (t) => this.comparison(t));
  }

  private comparison(tokens: Tokens): Expr {
    return this.binaryLevel(tokens, ['<=', '>=', '<', '>'], (t) => this.additive(t));
  }

  private additive(tokens: Tokens): Expr {
    return this.binaryLevel(tokens, ['+', '-'], (t) => this.multiplicative(t));
  }

  private multiplicative(tokens: Tokens): Expr {
    return this.binaryLevel(tokens, ['*', '/', '%'], (t) => this.unary(t));
  }

  private unary(tokens: Tokens): Expr {
    const token = tokens.peek();
    if (token && (tokens.is('-') || tokens.is('+') || tokens.is('not'))) {
      tokens.next();
      const operand = this.unary(tokens);
      return {
        kind: 'unary',
        op: token.text as '-' | '+' | 'not',
        operand,
        span: spanOf(token, operand.span),
      };
    }
    return this.postfix(tokens);
  }

  private postfix(tokens: Tokens): Expr {
    let expr = this.primary(tokens);
    while (tokens.is('[')) {
      if (expr.kind === 'history') {
        throw new PineCompileError(
          'The [] operator can only be used once on the same value',
          tokens.peek() as Token,
        );
      }
      tokens.next();
      const offset = this.expression(tokens);
      const close = tokens.expect(']');
      expr = { kind: 'history', target: expr, offset, span: spanOf(expr.span, close) };
    }
    return expr;
  }

  private primary(tokens: Tokens): Expr {
    const token = tokens.next();
    switch (token.kind) {
      case 'int':
      case 'float':
        return {
          kind: 'number',
          value: token.value as number,
          float: token.kind === 'float',
          span: token,
        };
      case 'string':
        return { kind: 'string', value: token.value as string, span: token };
      case 'color':
        return { kind: 'color', value: token.value as number, span: token };
      case 'ident':
        return this.nameOrCall(tokens, token);
      case 'keyword':
        if (STRUCTURES.has(token.text)) {
          throw new PineCompileError(
            `An ${token.text} structure can only start a statement or follow "=" or ":="`,
            token,
          );
        }
        throw new PineCompileError(`Syntax error at "${token.text}"`, token);
      default:
        break;
    }
    if (token.text === '(') {
      const inner = this.expression(tokens);
      tokens.expect(')');
      return inner;
    }
    if (token.text === '[') {
      const items: Expr[] = [];
      if (!tokens.is(']')) {
        do {
          items.push(this.expression(tokens));
        } while (tokens.accept(','));
      }
      const close = tokens.expect(']');
      return { kind: 'list', items, span: spanOf(token, close) };
    }
    throw new PineCompileError(`Syntax error at "${token.text}"`, token);
  }

  private nameOrCall(tokens: Tokens, first: Token): Expr {
    let name = first.text;
    let end: Span = first;
    while (tokens.is('.') && tokens.peek(1)?.kind === 'ident') {
      tokens.next();
      const part = tokens.next();
      name += `.${part.text}`;
      end = part;
    }
    const nameSpan = spanOf(first, end);
    if (
      tokens.is('<') &&
      tokens.peek(1)?.kind === 'ident' &&
      tokens.is('>', 2) &&
      tokens.is('(', 3)
    ) {
      throw new PineCompileError('Arrays, matrices and maps come later (P2)', nameSpan);
    }
    if (!tokens.is('(')) {
      if (name === 'na') return { kind: 'na', span: nameSpan };
      if (name === 'true' || name === 'false')
        return { kind: 'bool', value: name === 'true', span: nameSpan };
      return { kind: 'name', name, span: nameSpan };
    }
    tokens.next();
    const args: { name: string | null; value: Expr; span: Span }[] = [];
    if (!tokens.is(')')) {
      do {
        const argStart = tokens.peek() as Token;
        let argName: string | null = null;
        if (argStart.kind === 'ident' && tokens.is('=', 1)) {
          argName = argStart.text;
          tokens.next();
          tokens.next();
        } else if (args.some((arg) => arg.name !== null)) {
          throw new PineCompileError('Positional arguments must come before named ones', argStart);
        }
        const value = this.expression(tokens);
        args.push({ name: argName, value, span: spanOf(argStart, value.span) });
      } while (tokens.accept(','));
    }
    const close = tokens.expect(')', '")" to close the call');
    return { kind: 'call', callee: name, calleeSpan: nameSpan, args, span: spanOf(first, close) };
  }
}

/** Reads a script into its syntax tree, or throws its first syntax error. */
export function parse(source: string): Script {
  const { lines, version, annotations } = lex(source);
  const statements = new Parser(lines).script();
  return { version, statements, annotations };
}
