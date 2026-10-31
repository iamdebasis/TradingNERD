import type { Span } from './diagnostics.ts';

/** Pine's fundamental types we have in P1 (the type keywords a declaration may use). */
export type TypeName = 'int' | 'float' | 'bool' | 'color' | 'string';
export const TYPE_NAMES: readonly TypeName[] = ['int', 'float', 'bool', 'color', 'string'];

/** A declaration's or parameter's explicit qualifier keyword. */
export type QualifierWord = 'const' | 'simple' | 'series';

export interface Arg {
  /** A named argument's name (`title = "RSI"`), or null for a positional one. */
  name: string | null;
  value: Expr;
  span: Span;
}

export interface Block {
  /** The block's value is its last statement's (Pine's local blocks). */
  statements: Stmt[];
  span: Span;
}

export interface IfBranch {
  cond: Expr;
  body: Block;
}

export interface SwitchCase {
  /** The value or condition this case matches; null for the default `=>` case. */
  match: Expr | null;
  body: Block;
}

export type Expr =
  | { kind: 'number'; value: number; float: boolean; span: Span }
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'color'; value: number; span: Span }
  | { kind: 'na'; span: Span }
  /** A name, dotted for namespaces: `close`, `ta.tr`, `color.red`, `syminfo.ticker`. */
  | { kind: 'name'; name: string; span: Span }
  | { kind: 'call'; callee: string; calleeSpan: Span; args: Arg[]; span: Span }
  | { kind: 'unary'; op: '-' | '+' | 'not'; operand: Expr; span: Span }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; span: Span }
  | { kind: 'ternary'; cond: Expr; then: Expr; otherwise: Expr; span: Span }
  /** `x[offset]`: Pine's history-referencing operator. */
  | { kind: 'history'; target: Expr; offset: Expr; span: Span }
  /** `[a, b]`: a tuple a block returns, or an `options` list. */
  | { kind: 'list'; items: Expr[]; span: Span }
  | { kind: 'if'; branches: IfBranch[]; otherwise: Block | null; span: Span }
  | { kind: 'switch'; subject: Expr | null; cases: SwitchCase[]; span: Span }
  | {
      kind: 'for';
      counter: string;
      counterSpan: Span;
      from: Expr;
      to: Expr;
      step: Expr | null;
      body: Block;
      span: Span;
    }
  | { kind: 'while'; cond: Expr; body: Block; span: Span };

export interface Param {
  name: string;
  type: TypeName | null;
  qualifier: QualifierWord | null;
  default: Expr | null;
  span: Span;
}

export type AssignOp = ':=' | '+=' | '-=' | '*=' | '/=' | '%=';

export type Stmt =
  | {
      kind: 'decl';
      mode: 'var' | 'varip' | null;
      qualifier: QualifierWord | null;
      type: TypeName | null;
      name: string;
      nameSpan: Span;
      value: Expr;
      span: Span;
    }
  | { kind: 'tupleDecl'; names: string[]; nameSpans: Span[]; value: Expr; span: Span }
  | { kind: 'assign'; op: AssignOp; name: string; nameSpan: Span; value: Expr; span: Span }
  | { kind: 'func'; name: string; nameSpan: Span; params: Param[]; body: Block; span: Span }
  | { kind: 'expr'; expr: Expr; span: Span }
  | { kind: 'break'; span: Span }
  | { kind: 'continue'; span: Span };

export interface Script {
  /** From `//@version=N`. */
  version: number | null;
  statements: Stmt[];
  annotations: { line: number; text: string }[];
}
