import { describe, expect, it } from 'vitest';
import type { Expr, Stmt } from './ast.ts';
import { PineCompileError } from './diagnostics.ts';
import { lex } from './lexer.ts';
import { parse } from './parser.ts';

const statements = (source: string) => parse(source).statements;

/** The first statement's expression. */
function exprOf(source: string): Expr {
  const [first] = statements(source);
  if (first?.kind !== 'expr') throw new Error(`Not an expression: ${first?.kind}`);
  return first.expr;
}

/** A compact form of an expression, to compare shapes. */
function show(expr: Expr): string {
  switch (expr.kind) {
    case 'number':
      return String(expr.value);
    case 'string':
      return JSON.stringify(expr.value);
    case 'bool':
      return String(expr.value);
    case 'color':
      return `#${expr.value}`;
    case 'na':
      return 'na';
    case 'name':
      return expr.name;
    case 'call':
      return `${expr.callee}(${expr.args.map((a) => (a.name ? `${a.name}=` : '') + show(a.value)).join(', ')})`;
    case 'unary':
      return `(${expr.op} ${show(expr.operand)})`;
    case 'binary':
      return `(${show(expr.left)} ${expr.op} ${show(expr.right)})`;
    case 'ternary':
      return `(${show(expr.cond)} ? ${show(expr.then)} : ${show(expr.otherwise)})`;
    case 'history':
      return `${show(expr.target)}[${show(expr.offset)}]`;
    case 'list':
      return `[${expr.items.map(show).join(', ')}]`;
    default:
      return expr.kind;
  }
}

function errorOf(source: string): PineCompileError {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof PineCompileError) return error;
    throw error;
  }
  throw new Error('No error');
}

describe('the lexer', () => {
  it("reads the version annotation and drops comments, as Pine's compiler does", () => {
    const { version, lines } = lex(
      '//@version=6\nindicator("RSI") // the declaration\n// a comment',
    );
    expect(version).toBe(6);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tokens.map((t) => t.text)).toEqual(['indicator', '(', '"RSI"', ')']);
  });

  it('joins wrapped lines: an indentation that is not a multiple of four, or open brackets', () => {
    const { lines } = lex(
      'a = open +\n      high +\n  low\nplot(a,\n    color = color.red)\nb = 1',
    );
    expect(lines.map((line) => line.tokens.map((t) => t.text).join(' '))).toEqual([
      'a = open + high + low',
      'plot ( a , color = color . red )',
      'b = 1',
    ]);
  });

  it('reads numbers, strings with escapes and colors with their transparency', () => {
    const [line] = lex('x = f(14, 2.5, 1e3, .5, "a\\"b", \'c\', #7E57C2, #FF000080)').lines;
    const values = line?.tokens.filter((t) => t.value !== undefined).map((t) => [t.kind, t.value]);
    expect(values).toEqual([
      ['int', 14],
      ['float', 2.5],
      ['float', 1000],
      ['float', 0.5],
      ['string', 'a"b'],
      ['string', 'c'],
      ['color', 0x7e * 16777216 + 0x57 * 65536 + 0xc2 * 256 + 0],
      ['color', 0xff * 16777216 + 0 + 0 + Math.round(100 * (1 - 0x80 / 255) * 2)],
    ]);
  });

  it('says where a color or a string is broken', () => {
    expect(() => lex('c = #12345')).toThrow(/isn't a color/);
    expect(() => lex('s = "open')).toThrow(/no closing quote/);
    expect(() => lex('x = 1 $ 2')).toThrow(/Unexpected character "\$"/);
  });
});

describe('the parser', () => {
  it("follows Pine's operator precedence", () => {
    expect(show(exprOf('a + b * c - d'))).toBe('((a + (b * c)) - d)');
    expect(show(exprOf('a > b and c or not d'))).toBe('(((a > b) and c) or (not d))');
    expect(show(exprOf('a == b != c'))).toBe('((a == b) != c)');
    expect(show(exprOf('x ? y : z ? 1 : 2'))).toBe('(x ? y : (z ? 1 : 2))');
    expect(show(exprOf('-close[1] + 2'))).toBe('((- close[1]) + 2)');
    expect(show(exprOf('ta.sma(close, 14)[1]'))).toBe('ta.sma(close, 14)[1]');
  });

  it('reads calls with positional and named arguments, dotted names, na and booleans', () => {
    expect(show(exprOf('plot(rsi, "RSI", color = #7E57C2, display = display.none)'))).toBe(
      `plot(rsi, "RSI", color=#${0x7e * 16777216 + 0x57 * 65536 + 0xc2 * 256}, display=display.none)`,
    );
    expect(show(exprOf('f(na, true, false)'))).toBe('f(na, true, false)');
    expect(() => parse('f(a = 1, 2)')).toThrow(/Positional arguments must come before named ones/);
  });

  it('reads declarations: var and varip, qualifiers, types, tuples and reassignments', () => {
    const [a, b, c, d, e] = statements(
      'var float x = na\nconst string T = "t"\n[m, s, h] = ta.macd(close, 12, 26, 9)\nx := 1\ny = 2, z = 3',
    ) as Stmt[];
    expect(a).toMatchObject({ kind: 'decl', mode: 'var', type: 'float', name: 'x' });
    expect(b).toMatchObject({ kind: 'decl', qualifier: 'const', type: 'string', name: 'T' });
    expect(c).toMatchObject({ kind: 'tupleDecl', names: ['m', 's', 'h'] });
    expect(d).toMatchObject({ kind: 'assign', op: ':=', name: 'x' });
    expect(e).toMatchObject({ kind: 'decl', name: 'y' });
    expect(statements('y = 2, z = 3')).toHaveLength(2);
  });

  it('reads if, else if and else as statements and as values', () => {
    const [decl] = statements(
      'c = if close > open\n    color.green\nelse if close < open\n    color.red\nelse\n    color.gray',
    );
    expect(decl?.kind).toBe('decl');
    const value = (decl as Extract<Stmt, { kind: 'decl' }>).value;
    expect(value.kind).toBe('if');
    if (value.kind === 'if') {
      expect(value.branches).toHaveLength(2);
      expect(value.otherwise?.statements).toHaveLength(1);
    }
  });

  it('reads switch with and without a subject, with a default case and blocks', () => {
    const source = [
      'ma = switch kind',
      '    "EMA" => ta.ema(src, len)',
      '    "WMA" =>',
      '        w = ta.wma(src, len)',
      '        w',
      '    => ta.sma(src, len)',
    ].join('\n');
    const value = (statements(source)[0] as Extract<Stmt, { kind: 'decl' }>).value;
    expect(value.kind).toBe('switch');
    if (value.kind === 'switch') {
      expect(value.cases.map((c) => (c.match ? show(c.match) : 'default'))).toEqual([
        '"EMA"',
        '"WMA"',
        'default',
      ]);
      expect(value.cases[1]?.body.statements).toHaveLength(2);
    }
  });

  it('reads for and while loops, with break and continue', () => {
    const [loop, whileLoop] = statements(
      'for i = 0 to 10 by 2\n    if i == 4\n        continue\n    s += i\nwhile j < 5\n    j += 1\n    break',
    );
    expect(loop).toMatchObject({ kind: 'expr', expr: { kind: 'for', counter: 'i' } });
    expect(whileLoop).toMatchObject({ kind: 'expr', expr: { kind: 'while' } });
  });

  it('reads single-line and multi-line functions, with typed and default parameters', () => {
    const [single, multi] = statements(
      'f(x, y = 2) => x + y\ng(series float src, simple int len) =>\n    a = ta.sma(src, len)\n    [a, len]',
    );
    expect(single).toMatchObject({
      kind: 'func',
      name: 'f',
      params: [{ name: 'x' }, { name: 'y' }],
    });
    expect(multi).toMatchObject({
      kind: 'func',
      params: [
        { name: 'src', type: 'float', qualifier: 'series' },
        { name: 'len', type: 'int', qualifier: 'simple' },
      ],
    });
    expect((multi as Extract<Stmt, { kind: 'func' }>).body.statements).toHaveLength(2);
  });

  it('says what is wrong, where, in plain words', () => {
    expect(errorOf('x = (1 + 2').message).toMatch(/[Ee]xpected "\)"/);
    expect(errorOf('if close > open\nplot(close)').message).toMatch(/Expected an indented block/);
    const nested = errorOf('if true\n    f(x) => x');
    expect(nested.message).toBe('Functions can only be declared in the global scope');
    expect(nested.span.line).toBe(2);
    expect(errorOf('close[1][2]').message).toMatch(/only be used once/);
    expect(errorOf('type Point\n    float x').message).toMatch(/User-defined types come later/);
    expect(errorOf('for x in arr\n    y = x').message).toMatch(/for…in loops come later/);
    expect(errorOf('array<float> a = na').message).toMatch(/Arrays, matrices and maps come later/);
  });
});
