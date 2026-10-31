import type { Span } from './diagnostics.ts';

/**
 * A type as the script writes it, in one canonical text: the fundamental types ("int", "float",
 * "bool", "color", "string"), collections ("array<float>", "map<string, float>",
 * "matrix<int>"; `float[]` reads as "array<float>"), drawing types ("label", "line",
 * "chart.point"), user-defined types and enums by name ("Point"), and a library's by its alias
 * ("lib.Point") (Pine docs, Type system).
 */
export type TypeRef = string;

/** Pine's fundamental types: the type keywords a declaration may use without a definition. */
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
  /**
   * A name, dotted for namespaces and fields: `close`, `ta.tr`, `color.red`, `point.x`,
   * `lib.MyEnum.up`. What each part is (a variable, a field, a namespace, an enum) is the
   * compiler's to find.
   */
  | { kind: 'name'; name: string; span: Span }
  /** A field of any value: `(obj[1]).x`, `arr.get(0).price`. */
  | { kind: 'member'; target: Expr; name: string; nameSpan: Span; span: Span }
  /**
   * A call. `callee` is the dotted name called (`ta.sma`, `array.new`, `arr.push`, `p.move`);
   * `receiver` is set for a method called on any value (`arr.get(0).copy()`, the name then
   * being the method's alone); `typeArgs` are a generic call's (`array.new<float>()`).
   */
  | {
      kind: 'call';
      callee: string;
      calleeSpan: Span;
      receiver: Expr | null;
      typeArgs: TypeRef[] | null;
      args: Arg[];
      span: Span;
    }
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
  /** `for x in collection` or `for [i, x] in collection` (Pine docs, Loops). */
  | {
      kind: 'forIn';
      names: string[];
      nameSpans: Span[];
      target: Expr;
      body: Block;
      span: Span;
    }
  | { kind: 'while'; cond: Expr; body: Block; span: Span }
  /**
   * An expression the compiler has already compiled (never parsed): a method's receiver passed
   * on as its first argument (`arr.push(x)` is `array.push(arr, x)`).
   */
  | { kind: 'compiled'; compiled: unknown; span: Span };

export interface Param {
  name: string;
  type: TypeRef | null;
  qualifier: QualifierWord | null;
  default: Expr | null;
  span: Span;
}

/** A field of a user-defined type: `float price = 0.0`. */
export interface Field {
  name: string;
  type: TypeRef;
  default: Expr | null;
  /** `varip` fields keep their values through the live bar's updates. */
  varip: boolean;
  span: Span;
}

/** A member of an enum: `up = "Up trend"`. */
export interface EnumMember {
  name: string;
  /** Its title, as inputs and str.tostring show it; the name when not given. */
  title: Expr | null;
  span: Span;
}

export type AssignOp = ':=' | '+=' | '-=' | '*=' | '/=' | '%=';

export type Stmt =
  | {
      kind: 'decl';
      mode: 'var' | 'varip' | null;
      qualifier: QualifierWord | null;
      type: TypeRef | null;
      name: string;
      nameSpan: Span;
      value: Expr;
      span: Span;
    }
  | { kind: 'tupleDecl'; names: string[]; nameSpans: Span[]; value: Expr; span: Span }
  /** `x := …`, `obj.field += …`: the target is a name (dotted for fields) or a member. */
  | { kind: 'assign'; op: AssignOp; target: Expr; value: Expr; span: Span }
  | {
      kind: 'func';
      name: string;
      nameSpan: Span;
      params: Param[];
      body: Block;
      /** Declared with `method`: callable on its first parameter's type. */
      method: boolean;
      exported: boolean;
      span: Span;
    }
  | {
      kind: 'typeDecl';
      name: string;
      nameSpan: Span;
      fields: Field[];
      exported: boolean;
      span: Span;
    }
  | {
      kind: 'enumDecl';
      name: string;
      nameSpan: Span;
      members: EnumMember[];
      exported: boolean;
      span: Span;
    }
  /** `import user/name/version as alias` (Pine docs, Libraries). */
  | {
      kind: 'import';
      publisher: string;
      library: string;
      version: number;
      alias: string;
      span: Span;
    }
  | { kind: 'expr'; expr: Expr; span: Span }
  | { kind: 'break'; span: Span }
  | { kind: 'continue'; span: Span };

export interface Script {
  /** From `//@version=N`; null when the script doesn't say (Pine then assumes 1). */
  version: number | null;
  statements: Stmt[];
  annotations: { line: number; text: string }[];
}

/** The version a script runs as: its `//@version`, or 1 when it has none (Pine docs). */
export const versionOf = (script: Script): number => script.version ?? 1;
