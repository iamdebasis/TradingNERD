import type { Block, Expr, Param, Script, Stmt } from './ast.ts';
import { compileBuiltinName, compileCall, compileHistoryOfBuiltin } from './builtins.ts';
import {
  PineCompileError,
  type PineDiagnostic,
  PineRuntimeError,
  type Span,
} from './diagnostics.ts';
import { Runtime, type Slot } from './runtime.ts';
import {
  assignable,
  type Base,
  CONST,
  type Compiled,
  type FoldEnv,
  INPUT,
  isNumeric,
  maxQual,
  naOf,
  type Qual,
  SERIES,
  SIMPLE,
  typeName,
  unify,
} from './types.ts';
import { mod, type OutputRef, type Value } from './values.ts';

/** An input, as the Inputs tab shows it (Pine docs, Inputs). */
export interface InputDef {
  index: number;
  kind: 'int' | 'float' | 'bool' | 'color' | 'string' | 'source';
  title: string;
  defval: Value;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: Value[];
  tooltip?: string;
  inline?: string;
  group?: string;
  /** Pine's display flags for the input (the legend shows it with status_line). */
  display: number;
  /** Greyed out unless this holds (`active = …`). */
  active?: (env: FoldEnv) => boolean;
  span: Span;
}

/** A value worked out before the bars, from the inputs alone (const and input arguments). */
export type Fold = (env: FoldEnv) => Value;

/** An argument worked out before the bars from the inputs, or per bar when it's a series. */
export interface StyleArg {
  fold: Fold;
  /** Changes from bar to bar: the runtime writes it with each bar's outputs. */
  dynamic: boolean;
}

/** plot()'s arguments (the v6 reference): const ones as values, input ones as folds. */
export interface PlotDef {
  index: number;
  title: string;
  color: StyleArg;
  linewidth: Fold;
  style: Fold;
  linestyle: Fold;
  trackprice: Fold;
  histbase: Fold;
  offset: Fold;
  join: Fold;
  editable: boolean;
  showLast: Fold;
  display: Fold;
  format: Fold;
  precision: Fold;
  span: Span;
}

export interface HlineDef {
  index: number;
  price: Fold;
  title: string;
  color: Fold;
  linestyle: Fold;
  linewidth: Fold;
  editable: boolean;
  display: Fold;
  span: Span;
}

export interface FillDef {
  index: number;
  a: OutputRef;
  b: OutputRef;
  /** A solid fill's color; null for a gradient. */
  color: StyleArg | null;
  gradient: { top: Fold; bottom: Fold; topColor: Fold; bottomColor: Fold } | null;
  title: string;
  editable: boolean;
  showLast: Fold;
  fillgaps: boolean;
  display: Fold;
  span: Span;
}

export interface BgcolorDef {
  index: number;
  color: StyleArg;
  offset: Fold;
  editable: boolean;
  showLast: Fold;
  title: string;
  display: Fold;
  span: Span;
}

/** indicator()'s arguments: all const in Pine. */
export interface IndicatorDecl {
  title: string;
  shorttitle: string;
  overlay: boolean;
  /** format.*: "inherit", "price", "volume", "percent" or "mintick". */
  format: string;
  /** Decimals for the values; null for the format's own. */
  precision: number | null;
  span: Span;
}

/** A variable in a scope. */
interface Var {
  base: Base;
  qual: Qual;
  slot: Slot;
  /** The declaration, so a later pass knows its strongest qualifier. */
  key: object;
  isConst: boolean;
  span: Span;
  /** Where it was declared, for functions that may only see what came before them. */
  line: number;
}

export class Scope {
  readonly parent: Scope | null;
  readonly kind: 'global' | 'local' | 'function';
  readonly vars = new Map<string, Var>();

  constructor(parent: Scope | null, kind: 'global' | 'local' | 'function') {
    this.parent = parent;
    this.kind = kind;
  }

  lookup(name: string): Var | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }

  get global(): boolean {
    return this.kind === 'global';
  }
}

/** A compiled statement: runs it and gives its value (a block's value is its last statement's). */
type Run = (rt: Runtime) => Value;

interface CompiledBlock {
  run: Run;
  base: Base;
  items?: Base[];
  qual: Qual;
}

/** Everything one compile pass makes. */
export interface CompiledProgram {
  runtime: Runtime;
  run: (rt: Runtime) => void;
  inputs: InputDef[];
  plots: PlotDef[];
  hlines: HlineDef[];
  fills: FillDef[];
  bgcolors: BgcolorDef[];
  indicator: IndicatorDecl;
  warnings: PineDiagnostic[];
  /** Each declaration's strongest qualifier this pass found. */
  quals: Map<object, Qual>;
}

/** Names the script reads history of (`x[k]`): their variables keep every value. */
function historyNames(statements: readonly Stmt[]): Set<string> {
  const names = new Set<string>();
  const visitExpr = (expr: Expr | null | undefined): void => {
    if (!expr) return;
    switch (expr.kind) {
      case 'history':
        if (expr.target.kind === 'name') names.add(expr.target.name);
        visitExpr(expr.target);
        visitExpr(expr.offset);
        return;
      case 'call':
        for (const arg of expr.args) visitExpr(arg.value);
        return;
      case 'unary':
        visitExpr(expr.operand);
        return;
      case 'binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'ternary':
        visitExpr(expr.cond);
        visitExpr(expr.then);
        visitExpr(expr.otherwise);
        return;
      case 'list':
        expr.items.forEach(visitExpr);
        return;
      case 'if':
        for (const branch of expr.branches) {
          visitExpr(branch.cond);
          visitBlock(branch.body);
        }
        if (expr.otherwise) visitBlock(expr.otherwise);
        return;
      case 'switch':
        visitExpr(expr.subject);
        for (const c of expr.cases) {
          visitExpr(c.match);
          visitBlock(c.body);
        }
        return;
      case 'for':
        visitExpr(expr.from);
        visitExpr(expr.to);
        visitExpr(expr.step);
        visitBlock(expr.body);
        return;
      case 'while':
        visitExpr(expr.cond);
        visitBlock(expr.body);
        return;
      default:
        return;
    }
  };
  const visitStmt = (stmt: Stmt): void => {
    switch (stmt.kind) {
      case 'decl':
      case 'tupleDecl':
      case 'assign':
        visitExpr(stmt.value);
        return;
      case 'expr':
        visitExpr(stmt.expr);
        return;
      case 'func':
        for (const param of stmt.params) visitExpr(param.default);
        visitBlock(stmt.body);
        return;
      default:
        return;
    }
  };
  const visitBlock = (block: Block): void => block.statements.forEach(visitStmt);
  statements.forEach(visitStmt);
  return names;
}

const OUTPUT_ONLY_GLOBAL = new Set(['plot', 'hline', 'fill', 'bgcolor', 'indicator']);

export class Compiler {
  readonly rt = new Runtime();
  readonly inputs: InputDef[] = [];
  readonly plots: PlotDef[] = [];
  readonly hlines: HlineDef[] = [];
  readonly fills: FillDef[] = [];
  readonly bgcolors: BgcolorDef[] = [];
  indicator: IndicatorDecl | null = null;
  readonly warnings: PineDiagnostic[] = [];
  readonly quals = new Map<object, Qual>();
  private readonly floors: ReadonlyMap<object, Qual>;
  /** The last pass: qualifier errors count only now, once every variable's is known. */
  readonly strict: boolean;
  private readonly lines: readonly string[];
  private readonly history: Set<string>;
  private readonly functions = new Map<string, Extract<Stmt, { kind: 'func' }>>();
  private readonly calling: string[] = [];
  /** How many loops the code being compiled is inside (in the function it's in). */
  private loops = 0;
  private readonly script: Script;

  constructor(script: Script, source: string, floors: ReadonlyMap<object, Qual>, strict: boolean) {
    this.script = script;
    this.lines = source.split(/\r?\n/);
    this.floors = floors;
    this.strict = strict;
    this.history = historyNames(script.statements);
  }

  compile(): CompiledProgram {
    const global = new Scope(null, 'global');
    for (const stmt of this.script.statements) {
      if (stmt.kind === 'func') {
        if (this.functions.has(stmt.name))
          this.fail(`Function "${stmt.name}" is already declared`, stmt.nameSpan);
        this.functions.set(stmt.name, stmt);
      }
    }
    const body = this.statements(this.script.statements, global);
    if (!this.indicator) {
      const first = this.script.statements[0]?.span ?? {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
      };
      this.fail('A script must declare indicator() (strategies and libraries come later)', first);
    }
    if (this.plots.length + this.bgcolors.length + this.hlines.length === 0) {
      this.fail(
        'An indicator must draw something: plot(), hline(), fill() or bgcolor()',
        (this.indicator as IndicatorDecl).span,
      );
    }
    return {
      runtime: this.rt,
      run: (rt) => {
        body.run(rt);
      },
      inputs: this.inputs,
      plots: this.plots,
      hlines: this.hlines,
      fills: this.fills,
      bgcolors: this.bgcolors,
      indicator: this.indicator as IndicatorDecl,
      warnings: this.warnings,
      quals: this.quals,
    };
  }

  // ---- messages ----

  fail(message: string, span: Span): never {
    throw new PineCompileError(message, span);
  }

  warn(message: string, span: Span): void {
    if (this.strict) this.warnings.push({ severity: 'warning', message, ...span });
  }

  /** The script's text at a span on one line, for messages that quote it. */
  text(span: Span): string {
    if (span.line !== span.endLine) return '…';
    return (this.lines[span.line - 1] ?? '').slice(span.column - 1, span.endColumn - 1);
  }

  /** A qualifier error, raised on the last pass only (Pine's own wording). */
  needQual(c: Compiled, max: Qual, fn: string, param: string, base: Base): void {
    if (!this.strict || c.qual <= max) return;
    const want = ['const', 'input', 'simple', 'series'][max];
    this.fail(
      `Cannot call '${fn}' with argument '${param}'='${this.text(c.span)}'. An argument of '${typeName(c)}' type was used but a '${want} ${base}' is expected.`,
      c.span,
    );
  }

  /** A type error for an argument. */
  needType(c: Compiled, ok: boolean, fn: string, param: string, want: string): void {
    if (ok) return;
    this.fail(
      `Cannot call '${fn}' with argument '${param}'='${this.text(c.span)}'. An argument of '${typeName(c)}' type was used but a '${want}' is expected.`,
      c.span,
    );
  }

  // ---- statements ----

  private statements(statements: readonly Stmt[], scope: Scope): CompiledBlock {
    const runs: Run[] = [];
    let last: CompiledBlock = { run: () => null, base: 'void', qual: CONST };
    for (const stmt of statements) {
      last = this.statement(stmt, scope);
      runs.push(last.run);
    }
    const count = runs.length;
    // Only inside a loop can a break or continue stop a block part way.
    const run: Run =
      count === 1
        ? (runs[0] as Run)
        : this.loops > 0
          ? (rt) => {
              let value: Value = null;
              for (let i = 0; i < count; i++) {
                value = (runs[i] as Run)(rt);
                if (rt.signal !== 0) return value;
              }
              return value;
            }
          : (rt) => {
              let value: Value = null;
              for (let i = 0; i < count; i++) value = (runs[i] as Run)(rt);
              return value;
            };
    return { run, base: last.base, items: last.items, qual: last.qual };
  }

  private block(block: Block, parent: Scope, kind: 'local' | 'function' = 'local'): CompiledBlock {
    return this.statements(block.statements, new Scope(parent, kind));
  }

  private statement(stmt: Stmt, scope: Scope): CompiledBlock {
    switch (stmt.kind) {
      case 'decl':
        return this.declaration(stmt, scope);
      case 'tupleDecl':
        return this.tupleDeclaration(stmt, scope);
      case 'assign':
        return this.assignment(stmt, scope);
      case 'func':
        if (!scope.global)
          this.fail('Functions can only be declared in the global scope', stmt.nameSpan);
        return { run: () => null, base: 'void', qual: CONST };
      case 'break':
      case 'continue': {
        if (this.loops === 0) this.fail(`"${stmt.kind}" can only be used inside a loop`, stmt.span);
        const signal = stmt.kind === 'break' ? 1 : 2;
        return {
          run: (rt) => {
            rt.signal = signal;
            return null;
          },
          base: 'void',
          qual: CONST,
        };
      }
      case 'expr': {
        const c = this.expr(stmt.expr, scope);
        return { run: c.ev, base: c.base, items: c.items, qual: c.qual };
      }
    }
  }

  private define(
    scope: Scope,
    name: string,
    span: Span,
    base: Base,
    qual: Qual,
    key: object,
    mode: 'var' | 'varip' | null,
    isConst: boolean,
  ): Var {
    if (name !== '_' && scope.vars.has(name)) {
      this.fail(`Variable "${name}" was already declared in this scope`, span);
    }
    if (name !== '_' && scope.parent?.lookup(name)) {
      this.warn(`Shadowing variable "${name}", which exists in an outer scope`, span);
    }
    const floor = this.floors.get(key) ?? CONST;
    const v: Var = {
      base,
      qual: maxQual(qual, floor),
      slot: this.rt.slot(mode, this.history.has(name), isNumeric(base) || base === 'color'),
      key,
      isConst,
      span,
      line: span.line,
    };
    if (name !== '_') scope.vars.set(name, v);
    this.raise(key, v.qual);
    return v;
  }

  /** Records a declaration's strongest qualifier for the next pass. */
  private raise(key: object, qual: Qual): void {
    this.quals.set(key, maxQual(this.quals.get(key) ?? CONST, qual));
  }

  private declaration(stmt: Extract<Stmt, { kind: 'decl' }>, scope: Scope): CompiledBlock {
    const value = this.expr(stmt.value, scope);
    if (value.base === 'tuple')
      this.fail('A tuple needs a tuple declaration: [a, b] = …', stmt.value.span);
    if (value.base === 'void') this.fail('This expression has no value to assign', stmt.value.span);
    let base: Base = value.base;
    if (stmt.type) {
      if (!assignable(value.base, stmt.type)) {
        this.fail(
          `Cannot assign a value of type '${value.base}' to the variable "${stmt.name}" of type '${stmt.type}'`,
          stmt.value.span,
        );
      }
      base = stmt.type;
    } else if (value.base === 'na') {
      this.fail(
        `Value with NA type cannot be assigned to a variable that was defined without type keyword: write "float ${stmt.name} = na"`,
        stmt.span,
      );
    }
    if (stmt.qualifier === 'const' && value.qual > CONST && this.strict) {
      this.fail(
        `"${stmt.name}" is declared const, but its value is ${typeName(value)}`,
        stmt.value.span,
      );
    }
    const declaredQual =
      stmt.qualifier === 'series'
        ? SERIES
        : stmt.qualifier === 'simple'
          ? maxQual(SIMPLE, value.qual)
          : value.qual;
    const v = this.define(
      scope,
      stmt.name,
      stmt.nameSpan,
      base,
      declaredQual,
      stmt,
      stmt.mode,
      stmt.qualifier === 'const',
    );
    if (value.fold && v.qual <= INPUT) this.registerFold(stmt, value.fold);
    const slot = v.slot;
    const cast = castTo(value, base);
    return {
      run: slot.mode ? (rt) => slot.push(slot.kept ? null : cast(rt)) : (rt) => slot.push(cast(rt)),
      base,
      qual: v.qual,
    };
  }

  private tupleDeclaration(
    stmt: Extract<Stmt, { kind: 'tupleDecl' }>,
    scope: Scope,
  ): CompiledBlock {
    const value = this.expr(stmt.value, scope);
    if (value.base !== 'tuple' || !value.items) {
      this.fail(
        'Only a function or a structure that returns a tuple can be unpacked',
        stmt.value.span,
      );
    }
    if (value.items.length !== stmt.names.length) {
      this.fail(
        `The tuple has ${value.items.length} values but ${stmt.names.length} names`,
        stmt.value.span,
      );
    }
    const slots = stmt.names.map((name, i) => {
      const base = value.items?.[i] ?? 'float';
      return this.define(
        scope,
        name,
        stmt.nameSpans[i] as Span,
        base,
        value.qual,
        stableKey(stmt, i),
        null,
        false,
      ).slot;
    });
    return {
      run: (rt) => {
        const tuple = value.ev(rt) as readonly Value[];
        for (let i = 0; i < slots.length; i++) {
          const v = tuple[i] ?? null;
          (slots[i] as Slot).push(v);
        }
        return null;
      },
      base: 'void',
      qual: value.qual,
    };
  }

  private assignment(stmt: Extract<Stmt, { kind: 'assign' }>, scope: Scope): CompiledBlock {
    const v = scope.lookup(stmt.name);
    if (!v) this.fail(`Undeclared identifier "${stmt.name}"`, stmt.nameSpan);
    if (v.isConst) this.fail(`"${stmt.name}" is const: it can't be reassigned`, stmt.nameSpan);
    const value = this.expr(stmt.value, scope);
    // A variable reassigned inside a block, or a var reassigned at all, changes from bar to bar:
    // it's a series from then on; elsewhere it takes the value's qualifier (Pine docs, Qualifiers).
    this.raise(v.key, scope.global && !v.slot.mode ? value.qual : SERIES);
    const slot = v.slot;
    if (stmt.op === ':=') {
      if (!assignable(value.base, v.base)) {
        this.fail(
          `Cannot assign a value of type '${value.base}' to the variable "${stmt.name}" of type '${v.base}'`,
          stmt.value.span,
        );
      }
      const cast = castTo(value, v.base);
      return {
        run: (rt) => {
          const next = cast(rt);
          slot.set(next);
          return next;
        },
        base: v.base,
        qual: v.qual,
      };
    }
    const op = stmt.op.slice(0, 1);
    const left: Compiled = {
      base: v.base,
      qual: v.qual,
      ev: () => slot.get(),
      span: stmt.nameSpan,
    };
    const combined = this.binary(op, left, value, stmt.span);
    if (!assignable(combined.base, v.base)) {
      this.fail(
        `"${stmt.name}" is '${v.base}': ${stmt.op} would make it '${combined.base}'`,
        stmt.span,
      );
    }
    return {
      run: (rt) => {
        const next = combined.ev(rt);
        slot.set(next);
        return next;
      },
      base: v.base,
      qual: v.qual,
    };
  }

  // ---- expressions ----

  expr(expr: Expr, scope: Scope): Compiled {
    switch (expr.kind) {
      case 'number': {
        const value = expr.value;
        return {
          base: expr.float ? 'float' : 'int',
          qual: CONST,
          ev: () => value,
          fold: () => value,
          span: expr.span,
        };
      }
      case 'string': {
        const value = expr.value;
        return { base: 'string', qual: CONST, ev: () => value, fold: () => value, span: expr.span };
      }
      case 'bool': {
        const value = expr.value;
        return { base: 'bool', qual: CONST, ev: () => value, fold: () => value, span: expr.span };
      }
      case 'color': {
        const value = expr.value;
        return { base: 'color', qual: CONST, ev: () => value, fold: () => value, span: expr.span };
      }
      case 'na':
        return {
          base: 'na',
          qual: CONST,
          ev: () => Number.NaN,
          fold: () => Number.NaN,
          span: expr.span,
        };
      case 'name':
        return this.name(expr, scope);
      case 'call':
        return this.call(expr, scope);
      case 'unary':
        return this.unary(expr, scope);
      case 'binary': {
        const left = this.expr(expr.left, scope);
        if (expr.op === 'and' || expr.op === 'or')
          return this.logical(expr.op, left, expr.right, scope, expr.span);
        const right = this.expr(expr.right, scope);
        return this.binary(expr.op, left, right, expr.span);
      }
      case 'ternary':
        return this.ternary(expr, scope);
      case 'history':
        return this.historyRef(expr, scope);
      case 'list':
        return this.fail(
          'A list in brackets can only be a tuple a block returns, or an options list',
          expr.span,
        );
      case 'if':
        return this.ifStructure(expr, scope);
      case 'switch':
        return this.switchStructure(expr, scope);
      case 'for':
        return this.forLoop(expr, scope);
      case 'while':
        return this.whileLoop(expr, scope);
    }
  }

  /** A block's value as an expression: tuples written `[a, b]` at its end are allowed. */
  private blockValue(block: Block, scope: Scope): CompiledBlock {
    const last = block.statements.at(-1);
    if (last?.kind === 'expr' && last.expr.kind === 'list') {
      const inner = new Scope(scope, 'local');
      const head = this.statements(block.statements.slice(0, -1), inner);
      const items = last.expr.items.map((item) => this.expr(item, inner));
      const evs = items.map((item) => item.ev);
      const qual = maxQual(...items.map((item) => item.qual));
      return {
        run: (rt) => {
          head.run(rt);
          if (rt.signal !== 0) return null;
          return evs.map((ev) => ev(rt));
        },
        base: 'tuple',
        items: items.map((item) => item.base),
        qual,
      };
    }
    return this.block(block, scope);
  }

  private name(expr: Extract<Expr, { kind: 'name' }>, scope: Scope): Compiled {
    const v = scope.lookup(expr.name);
    if (v) {
      const slot = v.slot;
      const base = v.base;
      return {
        base,
        qual: v.qual,
        ev: base === 'bool' ? () => slot.get() === true : () => slot.get() ?? naOf(base),
        fold: v.qual <= 1 ? (env) => this.foldVar(v, env) : undefined,
        span: expr.span,
      };
    }
    const builtin = compileBuiltinName(this, expr.name, expr.span);
    if (builtin) return builtin;
    if (this.functions.has(expr.name)) {
      return this.fail(`"${expr.name}" is a function: call it with ()`, expr.span);
    }
    return this.fail(`Undeclared identifier "${expr.name}"`, expr.span);
  }

  /** Const and input variables are worked out from their declaration. */
  private readonly folds = new Map<object, (env: FoldEnv) => Value>();

  registerFold(key: object, fold: (env: FoldEnv) => Value): void {
    this.folds.set(key, fold);
  }

  private foldVar(v: Var, env: FoldEnv): Value {
    const fold = this.folds.get(v.key);
    if (!fold) throw new PineCompileError('This value is only known on the chart', v.span);
    return fold(env);
  }

  private unary(expr: Extract<Expr, { kind: 'unary' }>, scope: Scope): Compiled {
    const operand = this.expr(expr.operand, scope);
    const ev = operand.ev;
    const fold = operand.fold;
    if (expr.op === 'not') {
      if (operand.base !== 'bool') {
        this.fail(`Cannot apply "not" to '${typeName(operand)}': it needs a bool`, expr.span);
      }
      return {
        base: 'bool',
        qual: operand.qual,
        ev: (rt) => !(ev(rt) as boolean),
        fold: fold && ((env) => !(fold(env) as boolean)),
        span: expr.span,
      };
    }
    if (!isNumeric(operand.base)) {
      this.fail(`Cannot apply "${expr.op}" to '${typeName(operand)}'`, expr.span);
    }
    const base = operand.base === 'na' ? 'float' : operand.base;
    if (expr.op === '+') return { ...operand, base, span: expr.span };
    return {
      base,
      qual: operand.qual,
      ev: (rt) => -(ev(rt) as number),
      fold: fold && ((env) => -(fold(env) as number)),
      span: expr.span,
    };
  }

  /** `and` and `or`, evaluated lazily as in Pine v6. */
  private logical(
    op: 'and' | 'or',
    left: Compiled,
    rightExpr: Expr,
    scope: Scope,
    span: Span,
  ): Compiled {
    const right = this.expr(rightExpr, scope);
    for (const side of [left, right]) {
      if (side.base !== 'bool') {
        this.fail(`"${op}" needs bool values, but this is '${typeName(side)}'`, side.span);
      }
    }
    const a = left.ev;
    const b = right.ev;
    const fa = left.fold;
    const fb = right.fold;
    const qual = maxQual(left.qual, right.qual);
    if (op === 'and') {
      return {
        base: 'bool',
        qual,
        ev: (rt) => (a(rt) as boolean) && (b(rt) as boolean),
        fold: fa && fb && ((env) => (fa(env) as boolean) && (fb(env) as boolean)),
        span,
      };
    }
    return {
      base: 'bool',
      qual,
      ev: (rt) => (a(rt) as boolean) || (b(rt) as boolean),
      fold: fa && fb && ((env) => (fa(env) as boolean) || (fb(env) as boolean)),
      span,
    };
  }

  binary(op: string, left: Compiled, right: Compiled, span: Span): Compiled {
    const qual = maxQual(left.qual, right.qual);
    const a = left.ev;
    const b = right.ev;
    const fa = left.fold;
    const fb = right.fold;
    const both = <T extends Value>(f: (x: Value, y: Value) => T) => ({
      ev: (rt: Runtime) => f(a(rt), b(rt)),
      fold: fa && fb ? (env: FoldEnv) => f(fa(env), fb(env)) : undefined,
    });
    if (op === '+' && (left.base === 'string' || right.base === 'string')) {
      if (
        (left.base !== 'string' && left.base !== 'na') ||
        (right.base !== 'string' && right.base !== 'na')
      ) {
        this.fail(`Cannot add '${typeName(left)}' and '${typeName(right)}'`, span);
      }
      return {
        base: 'string',
        qual,
        ...both((x, y) => (x === null || y === null ? null : (x as string) + (y as string))),
        span,
      };
    }
    if (op === '==' || op === '!=') {
      const unified = unify(left.base, right.base);
      if (!unified || unified === 'tuple' || unified === 'void') {
        this.fail(`Cannot compare '${typeName(left)}' with '${typeName(right)}'`, span);
      }
      // A comparison with na is false, either way (Pine docs, na value).
      const numeric =
        unified === 'int' || unified === 'float' || unified === 'color' || unified === 'na';
      const eq = numeric
        ? (x: Value, y: Value) => (x as number) === (y as number)
        : (x: Value, y: Value) => x !== null && y !== null && x === y;
      const ne = numeric
        ? (x: Value, y: Value) =>
            !Number.isNaN(x as number) && !Number.isNaN(y as number) && x !== y
        : (x: Value, y: Value) => x !== null && y !== null && x !== y;
      return { base: 'bool', qual, ...both(op === '==' ? eq : ne), span };
    }
    if (!isNumeric(left.base) || !isNumeric(right.base)) {
      this.fail(`Cannot apply "${op}" to '${typeName(left)}' and '${typeName(right)}'`, span);
    }
    const ints = left.base === 'int' && right.base === 'int';
    const number = ints ? 'int' : 'float';
    // Each operator gets a closure of its own, so the engine can make each one fast.
    const x = a as (rt: Runtime) => number;
    const y = b as (rt: Runtime) => number;
    switch (op) {
      case '<':
        return {
          base: 'bool',
          qual,
          ev: (rt) => x(rt) < y(rt),
          fold: both((p, q) => (p as number) < (q as number)).fold,
          span,
        };
      case '>':
        return {
          base: 'bool',
          qual,
          ev: (rt) => x(rt) > y(rt),
          fold: both((p, q) => (p as number) > (q as number)).fold,
          span,
        };
      case '<=':
        return {
          base: 'bool',
          qual,
          ev: (rt) => x(rt) <= y(rt),
          fold: both((p, q) => (p as number) <= (q as number)).fold,
          span,
        };
      case '>=':
        return {
          base: 'bool',
          qual,
          ev: (rt) => x(rt) >= y(rt),
          fold: both((p, q) => (p as number) >= (q as number)).fold,
          span,
        };
      case '+':
        return {
          base: number,
          qual,
          ev: (rt) => x(rt) + y(rt),
          fold: both((p, q) => (p as number) + (q as number)).fold,
          span,
        };
      case '-':
        return {
          base: number,
          qual,
          ev: (rt) => x(rt) - y(rt),
          fold: both((p, q) => (p as number) - (q as number)).fold,
          span,
        };
      case '*':
        return {
          base: number,
          qual,
          ev: (rt) => x(rt) * y(rt),
          fold: both((p, q) => (p as number) * (q as number)).fold,
          span,
        };
      case '/':
        // Division by zero is na in Pine; ints divide to a fraction.
        return {
          base: 'float',
          qual,
          ev: (rt) => divide(x(rt), y(rt)),
          fold: both((p, q) => divide(p as number, q as number)).fold,
          span,
        };
      case '%':
        return {
          base: number,
          qual,
          ev: (rt) => remainder(x(rt), y(rt)),
          fold: both((p, q) => remainder(p as number, q as number)).fold,
          span,
        };
      default:
        return this.fail(`Unknown operator "${op}"`, span);
    }
  }

  private ternary(expr: Extract<Expr, { kind: 'ternary' }>, scope: Scope): Compiled {
    const cond = this.condition(this.expr(expr.cond, scope));
    const then = this.expr(expr.then, scope);
    const otherwise = this.expr(expr.otherwise, scope);
    const base = unify(then.base, otherwise.base);
    if (!base || base === 'tuple' || base === 'void') {
      this.fail(
        `The two sides of ?: must have the same type, but one is '${then.base}' and the other '${otherwise.base}'`,
        expr.span,
      );
    }
    const c = cond.ev;
    const t = castTo(then, base);
    const o = castTo(otherwise, base);
    const fc = cond.fold;
    const ft = then.fold;
    const fo = otherwise.fold;
    return {
      base,
      qual: maxQual(cond.qual, then.qual, otherwise.qual),
      ev: (rt) => ((c(rt) as boolean) ? t(rt) : o(rt)),
      fold: fc && ft && fo ? (env) => ((fc(env) as boolean) ? ft(env) : fo(env)) : undefined,
      span: expr.span,
    };
  }

  /** A condition must be a bool in Pine v6; na counts as false. */
  condition(c: Compiled): Compiled {
    if (c.base === 'na') return { ...c, base: 'bool', ev: () => false, fold: () => false };
    if (c.base !== 'bool') {
      this.fail(
        `A condition must be a bool, but this is '${typeName(c)}': compare it, e.g. x > 0`,
        c.span,
      );
    }
    return c;
  }

  private historyRef(expr: Extract<Expr, { kind: 'history' }>, scope: Scope): Compiled {
    const offset = this.expr(expr.offset, scope);
    if (offset.base !== 'int') {
      this.fail(`The [] offset must be an int, but this is '${typeName(offset)}'`, offset.span);
    }
    const k = offset.ev;
    if (expr.target.kind === 'name') {
      const v = scope.lookup(expr.target.name);
      if (v) {
        const slot = v.slot;
        const base = v.base;
        const na = naOf(base);
        return {
          base,
          qual: SERIES,
          ev: (rt) => {
            const n = k(rt) as number;
            if (!(n >= 0)) throw historyError(n, expr.span);
            const value = slot.back(n);
            return value === undefined ? na : value;
          },
          span: expr.span,
        };
      }
      const builtin = compileHistoryOfBuiltin(this, expr.target.name, offset, expr.span);
      if (builtin) return builtin;
    }
    // An expression's or a call's history: kept in a hidden variable of its own.
    const target = this.expr(expr.target, scope);
    if (target.base === 'tuple' || target.base === 'void') {
      this.fail(`Cannot use [] on '${target.base}'`, expr.span);
    }
    const slot = this.rt.slot(null, true, isNumeric(target.base) || target.base === 'color');
    const ev = target.ev;
    const na = naOf(target.base);
    return {
      base: target.base,
      qual: SERIES,
      ev: (rt) => {
        slot.push(ev(rt));
        const n = k(rt) as number;
        if (!(n >= 0)) throw historyError(n, expr.span);
        const value = slot.back(n);
        return value === undefined ? na : value;
      },
      span: expr.span,
    };
  }

  private ifStructure(expr: Extract<Expr, { kind: 'if' }>, scope: Scope): Compiled {
    const conds = expr.branches.map((branch) => this.condition(this.expr(branch.cond, scope)).ev);
    const bodies = expr.branches.map((branch) => this.blockValue(branch.body, scope));
    const otherwise = expr.otherwise ? this.blockValue(expr.otherwise, scope) : null;
    const all = otherwise ? [...bodies, otherwise] : bodies;
    const { base, items } = this.unifyBlocks(all, expr.span);
    // No block ran: na, false for bool (Pine docs, if structure).
    const empty = base === 'tuple' ? (items ?? []).map(naOf) : naOf(base);
    const runs = bodies.map((body) => body.run);
    const otherRun = otherwise?.run ?? null;
    const count = conds.length;
    return {
      base,
      items,
      qual: SERIES,
      ev: (rt) => {
        for (let i = 0; i < count; i++) {
          if ((conds[i] as (rt: Runtime) => Value)(rt) as boolean) return (runs[i] as Run)(rt);
        }
        return otherRun ? otherRun(rt) : empty;
      },
      span: expr.span,
    };
  }

  private unifyBlocks(
    blocks: readonly CompiledBlock[],
    span: Span,
  ): { base: Base; items?: Base[] } {
    let base: Base = 'na';
    let items: Base[] | undefined;
    for (const block of blocks) {
      if (block.base === 'void') return { base: 'void' };
      if (block.base === 'tuple') {
        if (items && items.length !== (block.items ?? []).length) {
          this.fail('Every block must return a tuple of the same size', span);
        }
        items = (block.items ?? []).map((item, i) => unify(items?.[i] ?? item, item) ?? item);
        base = 'tuple';
        continue;
      }
      const next = unify(base, block.base);
      if (!next) return { base: 'void' };
      base = next;
    }
    return base === 'tuple' ? { base, items } : { base: base === 'na' ? 'float' : base };
  }

  private switchStructure(expr: Extract<Expr, { kind: 'switch' }>, scope: Scope): Compiled {
    const subject = expr.subject ? this.expr(expr.subject, scope) : null;
    const matches = expr.cases.map((c) => {
      if (!c.match) return null;
      const match = this.expr(c.match, scope);
      if (subject) {
        const eq = this.binary('==', subject, match, c.match.span);
        return eq.ev;
      }
      return this.condition(match).ev;
    });
    const bodies = expr.cases.map((c) => this.blockValue(c.body, scope));
    const { base, items } = this.unifyBlocks(bodies, expr.span);
    const empty = base === 'tuple' ? (items ?? []).map(naOf) : naOf(base);
    const runs = bodies.map((body) => body.run);
    const count = runs.length;
    return {
      base,
      items,
      qual: SERIES,
      ev: (rt) => {
        for (let i = 0; i < count; i++) {
          const match = matches[i];
          if (!match || (match(rt) as boolean)) return (runs[i] as Run)(rt);
        }
        return empty;
      },
      span: expr.span,
    };
  }

  private forLoop(expr: Extract<Expr, { kind: 'for' }>, scope: Scope): Compiled {
    const from = this.expr(expr.from, scope);
    const to = this.expr(expr.to, scope);
    const step = expr.step ? this.expr(expr.step, scope) : null;
    for (const part of [from, to, step]) {
      if (part && !isNumeric(part.base))
        this.fail(`A for loop counts with numbers, not '${typeName(part)}'`, part.span);
    }
    const inner = new Scope(scope, 'local');
    const counterBase: Base =
      from.base === 'float' || to.base === 'float' || step?.base === 'float' ? 'float' : 'int';
    const counter = this.define(
      inner,
      expr.counter,
      expr.counterSpan,
      counterBase,
      SERIES,
      expr,
      null,
      false,
    );
    this.loops++;
    const body = this.statements(expr.body.statements, inner);
    this.loops--;
    const f = from.ev;
    const t = to.ev;
    const s = step?.ev ?? (() => 1);
    const slot = counter.slot;
    const run = body.run;
    const empty = naOf(body.base);
    return {
      base: body.base === 'tuple' ? 'tuple' : body.base,
      items: body.items,
      qual: SERIES,
      ev: (rt) => {
        const start = f(rt) as number;
        const firstTo = t(rt) as number;
        const by = Math.abs(s(rt) as number);
        if (Number.isNaN(start) || Number.isNaN(firstTo) || !(by > 0)) return empty;
        const up = start <= firstTo;
        let value: Value = empty;
        slot.push(start);
        for (let i = start; ; i = up ? i + by : i - by) {
          const end = t(rt) as number;
          if (up ? i > end : i < end) break;
          slot.set(i);
          rt.tick();
          const result = run(rt);
          if (rt.signal === 1) {
            rt.signal = 0;
            break;
          }
          if (rt.signal === 2) {
            rt.signal = 0;
            continue;
          }
          value = result;
        }
        return value;
      },
      span: expr.span,
    };
  }

  private whileLoop(expr: Extract<Expr, { kind: 'while' }>, scope: Scope): Compiled {
    const cond = this.condition(this.expr(expr.cond, scope)).ev;
    this.loops++;
    const body = this.block(expr.body, scope);
    this.loops--;
    const run = body.run;
    const empty = naOf(body.base);
    return {
      base: body.base,
      items: body.items,
      qual: SERIES,
      ev: (rt) => {
        let value: Value = empty;
        while (cond(rt) as boolean) {
          rt.tick();
          const result = run(rt);
          if (rt.signal === 1) {
            rt.signal = 0;
            break;
          }
          if (rt.signal === 2) {
            rt.signal = 0;
            continue;
          }
          value = result;
        }
        return value;
      },
      span: expr.span,
    };
  }

  // ---- calls ----

  private call(expr: Extract<Expr, { kind: 'call' }>, scope: Scope): Compiled {
    if (OUTPUT_ONLY_GLOBAL.has(expr.callee) && !scope.global) {
      this.fail(
        `Cannot call '${expr.callee}' inside a local block or a function: only in the script's global scope`,
        expr.calleeSpan,
      );
    }
    const user = this.functions.get(expr.callee);
    if (user) return this.userCall(user, expr, scope);
    return compileCall(this, expr, scope);
  }

  /** Each call of a user function gets its own copy of the body: its own history (Pine docs). */
  private userCall(
    fn: Extract<Stmt, { kind: 'func' }>,
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
  ): Compiled {
    if (this.calling.includes(fn.name)) {
      this.fail(
        `Recursive calls aren't allowed in Pine: "${fn.name}" calls itself`,
        expr.calleeSpan,
      );
    }
    const args = this.bindUserArgs(fn, expr, scope);
    const fnScope = new Scope(this.globalScope(scope), 'function');
    const params = fn.params.map((param, i) => {
      const arg = args[i] as Compiled;
      const base = param.type ?? (arg.base === 'na' ? 'float' : arg.base);
      if (param.type && !assignable(arg.base, param.type)) {
        this.fail(
          `Cannot call '${fn.name}' with argument '${param.name}'='${this.text(arg.span)}'. An argument of '${typeName(arg)}' type was used but a '${param.type}' is expected.`,
          arg.span,
        );
      }
      if (param.qualifier === 'simple' || param.qualifier === 'const') {
        this.needQual(arg, param.qualifier === 'const' ? CONST : SIMPLE, fn.name, param.name, base);
      }
      const qual = param.qualifier === 'series' ? SERIES : arg.qual;
      const key = stableKey(param, expr);
      const v = this.define(fnScope, param.name, param.span, base, qual, key, null, false);
      if (arg.fold) this.registerFold(key, arg.fold);
      return { slot: v.slot, ev: castTo(arg, base) };
    });
    this.calling.push(fn.name);
    // A function's body is its own: a loop around the call doesn't let it break.
    const loops = this.loops;
    this.loops = 0;
    const body = this.blockValueOfFunction(fn.body, fnScope);
    this.loops = loops;
    this.calling.pop();
    const run = body.run;
    const count = params.length;
    return {
      base: body.base,
      items: body.items,
      qual: body.base === 'tuple' ? maxQual(SIMPLE, body.qual) : body.qual,
      ev: (rt) => {
        for (let i = 0; i < count; i++) {
          const p = params[i] as { slot: Slot; ev: (rt: Runtime) => Value };
          const value = p.ev(rt);
          p.slot.push(value);
        }
        const value = run(rt);
        rt.signal = 0;
        return value;
      },
      span: expr.span,
    };
  }

  private blockValueOfFunction(block: Block, scope: Scope): CompiledBlock {
    // The function's scope itself holds its parameters; its statements share it.
    const last = block.statements.at(-1);
    if (last?.kind === 'expr' && last.expr.kind === 'list') return this.blockValue(block, scope);
    return this.statements(block.statements, scope);
  }

  private globalScope(scope: Scope): Scope {
    let s = scope;
    while (s.parent) s = s.parent;
    return s;
  }

  private bindUserArgs(
    fn: Extract<Stmt, { kind: 'func' }>,
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
  ): Compiled[] {
    const bound: (Compiled | undefined)[] = fn.params.map(() => undefined);
    let position = 0;
    for (const arg of expr.args) {
      if (arg.name === null) {
        if (position >= fn.params.length) {
          this.fail(`Too many arguments in the call to "${fn.name}"`, arg.span);
        }
        bound[position++] = this.expr(arg.value, scope);
        continue;
      }
      const i = fn.params.findIndex((param: Param) => param.name === arg.name);
      if (i < 0) this.fail(`"${fn.name}" has no parameter "${arg.name}"`, arg.span);
      bound[i] = this.expr(arg.value, scope);
    }
    return fn.params.map((param, i) => {
      const value = bound[i];
      if (value) return value;
      if (!param.default) {
        this.fail(`Missing the "${param.name}" argument in the call to "${fn.name}"`, expr.span);
      }
      return this.expr(param.default, this.globalScope(scope));
    });
  }
}

/** Converts a value to a declared type at run time: int → float stays a number; na → that type's na. */
export function castTo(c: Compiled, base: Base): (rt: Runtime) => Value {
  if (c.base === 'na') {
    const na = naOf(base);
    return () => na;
  }
  return c.ev;
}

const divide = (x: number, y: number) => (y === 0 ? Number.NaN : x / y);
// The Pine docs' own formula, a - b * math.floor(nz(a / b)): so x % 0 is x.
const remainder = (x: number, y: number) => (y === 0 ? x : mod(x, y));

function historyError(n: number, span: Span): PineRuntimeError {
  return new PineRuntimeError(
    `Invalid history reference [${Number.isNaN(n) ? 'na' : n}]: the offset must be 0 or more`,
    span,
  );
}

/**
 * A key for what one node and another (or an index) declare together, the same object on every
 * compile pass, so the qualifiers one pass finds reach the next (a tuple's names, a call's
 * parameters).
 */
const stableKeys = new WeakMap<object, Map<unknown, object>>();
function stableKey(owner: object, part: unknown): object {
  let keys = stableKeys.get(owner);
  if (!keys) {
    keys = new Map();
    stableKeys.set(owner, keys);
  }
  let key = keys.get(part);
  if (!key) {
    key = { owner, part };
    keys.set(part, key);
  }
  return key;
}
