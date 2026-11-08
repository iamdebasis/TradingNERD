import type {
  Arg,
  AssignOp,
  Block,
  EnumMember,
  Expr,
  Field,
  Param,
  QualifierWord,
  Script,
  Stmt,
  TypeRef,
} from './ast.ts';
import { PineCompileError, type Span, spanOf } from './diagnostics.ts';
import { type LogicalLine, lex, type Token } from './lexer.ts';

const ASSIGN_OPS: ReadonlySet<string> = new Set([':=', '+=', '-=', '*=', '/=', '%=']);
const QUALIFIERS: ReadonlySet<string> = new Set(['const', 'simple', 'series']);
const STRUCTURES: ReadonlySet<string> = new Set(['if', 'switch', 'for', 'while']);
/** Collection types that take type arguments, with how many. */
const GENERICS: Readonly<Record<string, number>> = { array: 1, matrix: 1, map: 2 };

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

  /** The token `offset` ahead is this operator or keyword. */
  is(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return (
      token !== undefined &&
      (token.kind === 'op' || token.kind === 'keyword') &&
      token.text === text
    );
  }

  /** The token `offset` ahead is a plain name. */
  isIdent(offset = 0): boolean {
    return this.peek(offset)?.kind === 'ident';
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

  /**
   * How many tokens a type takes from `offset` on (`float`, `chart.point`, `array<float>`,
   * `map<string, lib.T>`, `float[]`), or 0 when there's no type there.
   */
  typeLength(offset: number): number {
    let i = offset;
    if (!this.isIdent(i)) return 0;
    i++;
    while (this.is('.', i) && this.isIdent(i + 1)) i += 2;
    if (this.is('<', i)) {
      i++;
      for (;;) {
        const inner = this.typeLength(i);
        if (inner === 0) return 0;
        i += inner;
        if (this.is(',', i)) {
          i++;
          continue;
        }
        break;
      }
      if (!this.is('>', i)) return 0;
      i++;
    }
    while (this.is('[', i) && this.is(']', i + 1)) i += 2;
    return i - offset;
  }

  /** `name(…) =>` from `offset`: a function's declaration starts there. */
  startsFunctionAt(offset: number): boolean {
    if (!this.isIdent(offset) || !this.is('(', offset + 1)) return false;
    const close = this.closing(offset + 1);
    return close > 0 && this.is('=>', close + 1);
  }

  /** The index (from here) of the first assignment operator outside brackets, or -1. */
  assignmentAt(): number {
    let depth = 0;
    for (let i = this.index; i < this.tokens.length; i++) {
      const token = this.tokens[i] as Token;
      if (token.kind !== 'op') continue;
      if (token.text === '(' || token.text === '[') depth++;
      else if (token.text === ')' || token.text === ']') depth--;
      else if (depth === 0 && ASSIGN_OPS.has(token.text)) return i - this.index;
      else if (depth === 0 && (token.text === '=' || token.text === '?')) return -1;
    }
    return -1;
  }
}

/** Names a `<` after opens type arguments rather than comparing: `map<…>`, `array.new<…>`. */
const GENERIC_OPENERS: ReadonlySet<string> = new Set(['array', 'map', 'matrix', 'new']);

/**
 * Splits a line's tokens at its commas outside brackets: several statements on one line. The
 * commas of type arguments (`map.new<string, float>()`) don't split.
 */
function splitStatements(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  let generic = 0;
  tokens.forEach((token, i) => {
    if (token.kind === 'op') {
      const before = tokens[i - 1];
      if (token.text === '<' && before?.kind === 'ident' && GENERIC_OPENERS.has(before.text)) {
        generic++;
      } else if (token.text === '>' && generic > 0) generic--;
      else if (token.text === '(' || token.text === '[') depth++;
      else if (token.text === ')' || token.text === ']') depth--;
      else if (token.text === ',' && depth === 0 && generic === 0) {
        parts.push([]);
        return;
      }
    }
    (parts.at(-1) as Token[]).push(token);
  });
  return parts.filter((part) => part.length > 0);
}

/** A word that may follow a dot, keywords included (`input.enum`, `syminfo.type`). */
const isWord = (token: Token | undefined) =>
  token !== undefined && (token.kind === 'ident' || token.kind === 'keyword');

/** A type's canonical text: `float[]` → "array<float>", spaces after commas. */
export function typeText(base: string, args: readonly string[], arrayDepth: number): TypeRef {
  let type = args.length > 0 ? `${base}<${args.join(', ')}>` : base;
  for (let i = 0; i < arrayDepth; i++) type = `array<${type}>`;
  return type;
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
          'Unexpected indentation: only the lines of a block (after if, for, while, switch, a function, a type or an enum) are indented',
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
    const whole = new Tokens(line.tokens, line);
    if (first.kind === 'keyword') {
      switch (first.text) {
        case 'import':
          return [this.importStatement(whole, global)];
        case 'type':
          return [this.typeDeclaration(whole, line, global, false)];
        case 'enum':
          return [this.enumDeclaration(whole, line, global, false)];
        case 'method':
          return [this.func(whole, line, global, false)];
        case 'export':
          return [this.exported(whole, line, global)];
        default:
          break;
      }
    }
    // A structure or a function owns the lines under it: nothing else shares its line.
    if ((first.kind === 'keyword' && STRUCTURES.has(first.text)) || whole.startsFunctionAt(0)) {
      return [this.statement(whole, line, global)];
    }
    return splitStatements(line.tokens).map((tokens) =>
      this.statement(new Tokens(tokens, line), line, global),
    );
  }

  private exported(tokens: Tokens, line: LogicalLine, global: boolean): Stmt {
    const exportToken = tokens.next();
    if (!global)
      throw new PineCompileError('Only global declarations can be exported', exportToken);
    if (tokens.is('type')) return this.typeDeclaration(tokens, line, global, true);
    if (tokens.is('enum')) return this.enumDeclaration(tokens, line, global, true);
    if (tokens.is('method') || tokens.startsFunctionAt(0)) {
      return this.func(tokens, line, global, true);
    }
    throw new PineCompileError(
      'Only functions, methods, types and enums can be exported',
      tokens.peek() ?? exportToken,
    );
  }

  private importStatement(tokens: Tokens, global: boolean): Stmt {
    const keyword = tokens.next();
    if (!global) throw new PineCompileError('import can only be used in the global scope', keyword);
    // user/name/version: the user's name may hold characters a name can't, so it's read whole.
    const parts: Token[] = [];
    while (!tokens.atEnd() && !(tokens.isIdent() && tokens.peek()?.text === 'as')) {
      parts.push(tokens.next());
    }
    const path = parts.map((token) => token.text).join('');
    const match = /^([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
    const start = parts[0] ?? keyword;
    const end = parts.at(-1) ?? keyword;
    if (!match) {
      throw new PineCompileError(
        'An import is written import <user>/<library>/<version>, e.g. import TradingView/ta/7',
        spanOf(start, end),
      );
    }
    let alias = match[2] as string;
    let aliasEnd: Span = end;
    if (!tokens.atEnd()) {
      tokens.next(); // as
      const name = tokens.next();
      if (name.kind !== 'ident')
        throw new PineCompileError(`"${name.text}" can't be an alias`, name);
      alias = name.text;
      aliasEnd = name;
      tokens.expectEnd();
    }
    return {
      kind: 'import',
      publisher: match[1] as string,
      library: match[2] as string,
      version: Number(match[3]),
      alias,
      span: spanOf(keyword, aliasEnd),
    };
  }

  private typeDeclaration(
    tokens: Tokens,
    line: LogicalLine,
    global: boolean,
    exported: boolean,
  ): Stmt {
    const keyword = tokens.next();
    if (!global)
      throw new PineCompileError('Types can only be declared in the global scope', keyword);
    const name = tokens.next();
    if (name.kind !== 'ident')
      throw new PineCompileError(`"${name.text}" can't be a type's name`, name);
    tokens.expectEnd();
    const fields: Field[] = [];
    const indent = line.indent + 4;
    while (this.index < this.lines.length) {
      const next = this.lines[this.index] as LogicalLine;
      if (next.indent < indent) break;
      if (next.indent > indent) {
        throw new PineCompileError('Unexpected indentation in the type', next.tokens[0] as Token);
      }
      this.index++;
      const t = new Tokens(next.tokens, next);
      const start = t.peek() as Token;
      const varip = t.accept('varip') !== null;
      const length = t.typeLength(0);
      if (length === 0) {
        throw new PineCompileError('A field is written <type> <name> [= <default>]', start);
      }
      const type = this.type(t);
      const fieldName = t.next();
      if (fieldName.kind !== 'ident') {
        throw new PineCompileError(`"${fieldName.text}" can't be a field's name`, fieldName);
      }
      const fallback = t.accept('=') ? this.expression(t) : null;
      t.expectEnd();
      fields.push({
        name: fieldName.text,
        type,
        default: fallback,
        varip,
        span: spanOf(start, fallback?.span ?? fieldName),
      });
    }
    if (fields.length === 0) throw new PineCompileError('A type needs at least one field', name);
    return {
      kind: 'typeDecl',
      name: name.text,
      nameSpan: name,
      fields,
      exported,
      span: spanOf(keyword, (fields.at(-1) as Field).span),
    };
  }

  private enumDeclaration(
    tokens: Tokens,
    line: LogicalLine,
    global: boolean,
    exported: boolean,
  ): Stmt {
    const keyword = tokens.next();
    if (!global)
      throw new PineCompileError('Enums can only be declared in the global scope', keyword);
    const name = tokens.next();
    if (name.kind !== 'ident')
      throw new PineCompileError(`"${name.text}" can't be an enum's name`, name);
    tokens.expectEnd();
    const members: EnumMember[] = [];
    const indent = line.indent + 4;
    while (this.index < this.lines.length) {
      const next = this.lines[this.index] as LogicalLine;
      if (next.indent < indent) break;
      this.index++;
      const t = new Tokens(next.tokens, next);
      const member = t.next();
      if (member.kind !== 'ident') {
        throw new PineCompileError(`"${member.text}" can't be an enum member`, member);
      }
      const title = t.accept('=') ? this.expression(t) : null;
      t.expectEnd();
      members.push({ name: member.text, title, span: spanOf(member, title?.span ?? member) });
    }
    if (members.length === 0) throw new PineCompileError('An enum needs at least one member', name);
    return {
      kind: 'enumDecl',
      name: name.text,
      nameSpan: name,
      members,
      exported,
      span: spanOf(keyword, (members.at(-1) as EnumMember).span),
    };
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
      if (first.text === 'method') {
        throw new PineCompileError('Methods can only be declared in the global scope', first);
      }
    }
    if (tokens.startsFunctionAt(0)) {
      if (!global) {
        throw new PineCompileError('Functions can only be declared in the global scope', first);
      }
      return this.func(tokens, line, global, false);
    }
    if (first.kind === 'op' && first.text === '[') {
      const close = tokens.closing(0);
      if (close > 0 && tokens.is('=', close + 1)) return this.tupleDecl(tokens, line);
    }
    if (this.isDeclaration(tokens)) return this.declaration(tokens, line);
    const assign = tokens.assignmentAt();
    if (assign > 0) {
      const target = this.postfix(tokens);
      const opToken = tokens.next();
      if (!ASSIGN_OPS.has(opToken.text)) {
        throw new PineCompileError(`Syntax error at "${opToken.text}"`, opToken);
      }
      if (target.kind !== 'name' && target.kind !== 'member') {
        throw new PineCompileError('Only a variable or a field can be assigned', target.span);
      }
      const value = this.rhs(tokens, line);
      return {
        kind: 'assign',
        op: opToken.text as AssignOp,
        target,
        value,
        span: spanOf(target.span, value.span),
      };
    }
    const expr = this.expression(tokens);
    tokens.expectEnd();
    return { kind: 'expr', expr, span: expr.span };
  }

  /** `[var|varip] [const|simple|series] [<type>] <name> = …` starts here. */
  private isDeclaration(tokens: Tokens): boolean {
    let i = 0;
    if (tokens.is('var') || tokens.is('varip')) i++;
    if (tokens.peek(i)?.kind === 'keyword' && QUALIFIERS.has(tokens.peek(i)?.text ?? '')) i++;
    if (!tokens.isIdent(i)) return false;
    if (tokens.is('=', i + 1)) return true;
    const length = tokens.typeLength(i);
    return length > 0 && tokens.isIdent(i + length) && tokens.is('=', i + length + 1);
  }

  private declaration(tokens: Tokens, line: LogicalLine): Stmt {
    const start = tokens.peek() as Token;
    const mode = tokens.accept('var') ? 'var' : tokens.accept('varip') ? 'varip' : null;
    const qualifierToken = tokens.peek();
    let qualifier: QualifierWord | null = null;
    if (qualifierToken?.kind === 'keyword' && QUALIFIERS.has(qualifierToken.text)) {
      qualifier = tokens.next().text as QualifierWord;
    }
    const type = tokens.is('=', 1) ? null : this.type(tokens);
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

  /** A type, in canonical text (see TypeRef). */
  private type(tokens: Tokens): TypeRef {
    const first = tokens.next();
    if (first.kind !== 'ident') throw new PineCompileError(`"${first.text}" isn't a type`, first);
    let name = first.text;
    while (tokens.is('.') && tokens.isIdent(1)) {
      tokens.next();
      name += `.${tokens.next().text}`;
    }
    const args: TypeRef[] = [];
    if (tokens.accept('<')) {
      do {
        args.push(this.type(tokens));
      } while (tokens.accept(','));
      tokens.expect('>', '">" to close the type');
      const expected = GENERICS[name];
      if (expected !== undefined && args.length !== expected) {
        throw new PineCompileError(
          `"${name}" takes ${expected} type${expected === 1 ? '' : 's'} in <>`,
          first,
        );
      }
    }
    let depth = 0;
    while (tokens.is('[') && tokens.is(']', 1)) {
      tokens.next();
      tokens.next();
      depth++;
    }
    return typeText(name, args, depth);
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

  private func(tokens: Tokens, line: LogicalLine, global: boolean, exported: boolean): Stmt {
    const methodToken = tokens.accept('method');
    const name = tokens.next();
    if (!global) {
      throw new PineCompileError('Functions can only be declared in the global scope', name);
    }
    if (name.kind !== 'ident') throw new PineCompileError(`"${name.text}" can't be a name`, name);
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
      // One line can hold several statements, separated by commas; the last gives the result:
      // `printTable(txt) => var table t = table.new(…), table.cell(t, 0, 0, txt)` (the v6
      // manual, Colors). A structure keeps the rest of its line.
      const rest = tokens.rest();
      const first = rest[0];
      const parts =
        first?.kind === 'keyword' && STRUCTURES.has(first.text) ? [rest] : splitStatements(rest);
      const statements = parts.map((part) => this.statement(new Tokens(part, line), line, false));
      const last = statements.at(-1) as Stmt;
      body = { statements, span: spanOf(statements[0]?.span ?? last.span, last.span) };
    }
    if (methodToken && params.length === 0) {
      throw new PineCompileError('A method needs a first parameter: the value it works on', name);
    }
    return {
      kind: 'func',
      name: name.text,
      nameSpan: name,
      params,
      body,
      method: methodToken !== null,
      exported,
      span: spanOf(methodToken ?? name, body.span),
    };
  }

  private param(tokens: Tokens): Param {
    const start = tokens.peek() as Token;
    let qualifier: QualifierWord | null = null;
    if (start.kind === 'keyword' && QUALIFIERS.has(start.text)) {
      qualifier = tokens.next().text as QualifierWord;
    }
    let type: TypeRef | null = null;
    const length = tokens.typeLength(0);
    if (length > 0 && tokens.isIdent(length)) type = this.type(tokens);
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
    // for x in collection, for [i, x] in collection
    if (tokens.is('[')) {
      tokens.next();
      const names: string[] = [];
      const nameSpans: Span[] = [];
      do {
        const name = tokens.next();
        if (name.kind !== 'ident')
          throw new PineCompileError(`"${name.text}" can't be a name`, name);
        names.push(name.text);
        nameSpans.push(name);
      } while (tokens.accept(','));
      tokens.expect(']');
      tokens.expect('in', '"in"');
      return this.forInRest(tokens, line, keyword, names, nameSpans);
    }
    const counter = tokens.next();
    if (counter.kind !== 'ident')
      throw new PineCompileError(`"${counter.text}" can't be a counter`, counter);
    if (tokens.accept('in')) {
      return this.forInRest(tokens, line, keyword, [counter.text], [counter]);
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

  private forInRest(
    tokens: Tokens,
    line: LogicalLine,
    keyword: Token,
    names: string[],
    nameSpans: Span[],
  ): Expr {
    const target = this.expression(tokens);
    tokens.expectEnd();
    const body = this.block(line.indent + 4, target.span);
    return { kind: 'forIn', names, nameSpans, target, body, span: spanOf(keyword, body.span) };
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

  /** A value with what follows it: `[k]` history, `.field`, `.method(…)`. */
  private postfix(tokens: Tokens): Expr {
    let expr = this.primary(tokens);
    for (;;) {
      if (tokens.is('[')) {
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
        continue;
      }
      if (tokens.is('.') && isWord(tokens.peek(1))) {
        tokens.next();
        const name = tokens.next();
        const typeArgs = this.typeArgs(tokens);
        if (tokens.is('(')) {
          const { args, close } = this.args(tokens);
          expr = {
            kind: 'call',
            callee: name.text,
            calleeSpan: name,
            receiver: expr,
            typeArgs,
            args,
            span: spanOf(expr.span, close),
          };
          continue;
        }
        expr = {
          kind: 'member',
          target: expr,
          name: name.text,
          nameSpan: name,
          span: spanOf(expr.span, name),
        };
        continue;
      }
      return expr;
    }
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

  /** `<float>` or `<string, int>` before a call's `(`, or null when there's none. */
  private typeArgs(tokens: Tokens): TypeRef[] | null {
    if (!tokens.is('<')) return null;
    // A generic call only: the types must close with ">" right before "(".
    let i = 1;
    for (;;) {
      const length = tokens.typeLength(i);
      if (length === 0) return null;
      i += length;
      if (tokens.is(',', i)) {
        i++;
        continue;
      }
      break;
    }
    if (!tokens.is('>', i) || !tokens.is('(', i + 1)) return null;
    tokens.next();
    const types: TypeRef[] = [];
    do {
      types.push(this.type(tokens));
    } while (tokens.accept(','));
    tokens.expect('>');
    return types;
  }

  private args(tokens: Tokens): { args: Arg[]; close: Token } {
    tokens.expect('(');
    const args: Arg[] = [];
    if (!tokens.is(')')) {
      do {
        const argStart = tokens.peek() as Token;
        let argName: string | null = null;
        if (isWord(argStart) && tokens.is('=', 1)) {
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
    return { args, close };
  }

  private nameOrCall(tokens: Tokens, first: Token): Expr {
    let name = first.text;
    let end: Span = first;
    while (tokens.is('.') && isWord(tokens.peek(1))) {
      tokens.next();
      const part = tokens.next();
      name += `.${part.text}`;
      end = part;
    }
    const nameSpan = spanOf(first, end);
    const typeArgs = this.typeArgs(tokens);
    if (!tokens.is('(')) {
      if (name === 'na') return { kind: 'na', span: nameSpan };
      if (name === 'true' || name === 'false')
        return { kind: 'bool', value: name === 'true', span: nameSpan };
      return { kind: 'name', name, span: nameSpan };
    }
    const { args, close } = this.args(tokens);
    return {
      kind: 'call',
      callee: name,
      calleeSpan: nameSpan,
      receiver: null,
      typeArgs,
      args,
      span: spanOf(first, close),
    };
  }
}

/**
 * Reads a script into its syntax tree, or throws its first syntax error. A script without
 * `//@version` reads as `fallbackVersion` (see lex).
 */
export function parse(source: string, fallbackVersion = 1): Script {
  const { lines, version, annotations } = lex(source, fallbackVersion);
  const statements = new Parser(lines).script();
  return { version, statements, annotations };
}
