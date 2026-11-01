import type { Block, Expr, Param, Script, Stmt, TypeRef } from './ast.ts';
import { versionOf } from './ast.ts';
import {
  compileBuiltinName,
  compileCall,
  compileHistoryOfBuiltin,
  isBuiltinNamespace,
  methodNamespace,
} from './builtins.ts';
import {
  PineCompileError,
  type PineDiagnostic,
  PineRuntimeError,
  type Span,
} from './diagnostics.ts';
import { upgrade } from './dialect.ts';
import { parse } from './parser.ts';
import { Runtime, type Slot } from './runtime.ts';
import {
  assignable,
  type Base,
  BUILTIN_TYPES,
  CONST,
  type Compiled,
  castTo,
  DRAWING_TYPES,
  displayType,
  elemOf,
  type FoldEnv,
  genericName,
  INPUT,
  isArrayType,
  isMapType,
  isMatrixType,
  isNumeric,
  isNumericSlot,
  isReferenceType,
  maxQual,
  naOf,
  type Qual,
  SERIES,
  SIMPLE,
  typeArgs,
  typeName,
  unify,
} from './types.ts';
import {
  mod,
  type OutputRef,
  PineArray,
  PineEnum,
  type PineMap,
  type PineMatrix,
  PineObject,
  type Value,
} from './values.ts';

/** An input, as the Inputs tab shows it (Pine docs, Inputs). */
export interface InputDef {
  index: number;
  kind:
    | 'int'
    | 'float'
    | 'bool'
    | 'color'
    | 'string'
    | 'source'
    | 'timeframe'
    | 'symbol'
    | 'session'
    | 'time'
    | 'price'
    | 'text_area'
    | 'enum';
  title: string;
  defval: Value;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: Value[];
  /** An enum input's options, as the Inputs tab writes them (its members' titles). */
  optionTitles?: string[];
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

/** indicator()'s (or library()'s) arguments: all const in Pine. */
export interface IndicatorDecl {
  title: string;
  shorttitle: string;
  overlay: boolean;
  /** format.*: "inherit", "price", "volume", "percent" or "mintick". */
  format: string;
  /** Decimals for the values; null for the format's own. */
  precision: number | null;
  /** Declared with library(): its exports are what other scripts import. */
  library: boolean;
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

type FuncStmt = Extract<Stmt, { kind: 'func' }>;

/** A user-defined type, by its key (its name; a library's carries the library's path). */
export interface TypeDef {
  key: string;
  name: string;
  fields: { name: string; type: Base; default: Expr | null; varip: boolean }[];
  module: Module;
  exported: boolean;
  span: Span;
}

/** An enum, by its key; its members are the same objects wherever they're named. */
export interface EnumDef {
  key: string;
  name: string;
  members: PineEnum[];
  module: Module;
  exported: boolean;
  span: Span;
}

interface FuncDef {
  stmt: FuncStmt;
  module: Module;
}

/**
 * The script, or a library it imports (Pine docs, Libraries): its functions (several may share
 * a name, told apart by their parameters), methods, types, enums and imports.
 */
export class Module {
  /** "" for the script itself; "user/name/version" for a library. */
  readonly key: string;
  readonly version: number;
  readonly functions = new Map<string, FuncDef[]>();
  readonly methods = new Map<string, FuncDef[]>();
  readonly types = new Map<string, TypeDef>();
  readonly enums = new Map<string, EnumDef>();
  readonly imports = new Map<string, Module>();
  /** Its global scope, which its functions see (empty for a library: Pine forbids its globals). */
  readonly scope: Scope;

  constructor(key: string, version: number, scope: Scope) {
    this.key = key;
    this.version = version;
    this.scope = scope;
  }

  /** A type's or an enum's key as other modules see it. */
  keyOf(name: string): string {
    return this.key ? `${this.key}:${name}` : name;
  }
}

/** Where the compiler gets an imported library's code (the web app's My libraries). */
export type LibraryResolver = (publisher: string, name: string, version: number) => string | null;

export interface CompileOptions {
  resolveLibrary?: LibraryResolver;
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
        if (expr.target.kind === 'name') names.add(expr.target.name.split('.')[0] as string);
        visitExpr(expr.target);
        visitExpr(expr.offset);
        return;
      case 'member':
        visitExpr(expr.target);
        return;
      case 'call':
        visitExpr(expr.receiver);
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
      case 'forIn':
        visitExpr(expr.target);
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
        visitExpr(stmt.value);
        return;
      case 'assign':
        visitExpr(stmt.target);
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

const OUTPUT_ONLY_GLOBAL = new Set([
  'plot',
  'hline',
  'fill',
  'bgcolor',
  'indicator',
  'library',
  'plotshape',
  'plotchar',
  'plotarrow',
  'plotcandle',
  'plotbar',
  'barcolor',
]);

/** Libraries already read, by their code: parsing is the costly part, and code never changes. */
const parsedLibraries = new Map<string, Script>();

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
  /** The script's Pine version: older versions keep their own rules (v6 migration guide). */
  readonly version: number;
  /** Every user-defined type and enum the script and its libraries declare, by key. */
  readonly types = new Map<string, TypeDef>();
  readonly enums = new Map<string, EnumDef>();
  private readonly floors: ReadonlyMap<object, Qual>;
  /** The last pass: qualifier errors count only now, once every variable's is known. */
  readonly strict: boolean;
  private readonly lines: readonly string[];
  private readonly history: Set<string>;
  private readonly calling: string[] = [];
  /** How many loops the code being compiled is inside (in the function it's in). */
  private loops = 0;
  private readonly script: Script;
  private readonly options: CompileOptions;
  /** The module whose code is being compiled (a library's, inside its functions). */
  private module!: Module;
  /** Libraries loaded in this pass, by "user/name/version". */
  private readonly modules = new Map<string, Module>();

  constructor(
    script: Script,
    source: string,
    floors: ReadonlyMap<object, Qual>,
    strict: boolean,
    options: CompileOptions = {},
  ) {
    this.script = script;
    this.lines = source.split(/\r?\n/);
    this.floors = floors;
    this.strict = strict;
    this.options = options;
    this.version = versionOf(script);
    this.history = historyNames(script.statements);
  }

  compile(): CompiledProgram {
    const global = new Scope(null, 'global');
    const main = new Module('', this.version, global);
    this.module = main;
    this.declareAll(main, this.script.statements);
    const body = this.statements(this.script.statements, global);
    if (!this.indicator) {
      const first = this.script.statements[0]?.span ?? {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
      };
      this.fail('A script must declare indicator() or library()', first);
    }
    const decl = this.indicator as IndicatorDecl;
    if (!decl.library && this.plots.length + this.bgcolors.length + this.hlines.length === 0) {
      this.fail(
        'An indicator must draw something: plot(), hline(), fill(), bgcolor() or another output',
        decl.span,
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
      indicator: decl,
      warnings: this.warnings,
      quals: this.quals,
    };
  }

  // ---- declarations: functions, methods, types, enums, imports ----

  /** Registers a module's global declarations before its code compiles (they may come later). */
  private declareAll(module: Module, statements: readonly Stmt[]): void {
    for (const stmt of statements) {
      if (stmt.kind === 'import') this.importLibrary(module, stmt);
    }
    for (const stmt of statements) {
      switch (stmt.kind) {
        case 'typeDecl': {
          if (module.types.has(stmt.name) || module.enums.has(stmt.name)) {
            this.fail(`"${stmt.name}" is already declared`, stmt.nameSpan);
          }
          const def: TypeDef = {
            key: module.keyOf(stmt.name),
            name: stmt.name,
            fields: [],
            module,
            exported: stmt.exported,
            span: stmt.span,
          };
          module.types.set(stmt.name, def);
          this.types.set(def.key, def);
          break;
        }
        case 'enumDecl': {
          if (module.types.has(stmt.name) || module.enums.has(stmt.name)) {
            this.fail(`"${stmt.name}" is already declared`, stmt.nameSpan);
          }
          const key = module.keyOf(stmt.name);
          const def: EnumDef = {
            key,
            name: stmt.name,
            members: stmt.members.map(
              (member, i) =>
                new PineEnum(key, member.name, enumTitle(member.title, member.name), i),
            ),
            module,
            exported: stmt.exported,
            span: stmt.span,
          };
          module.enums.set(stmt.name, def);
          this.enums.set(key, def);
          break;
        }
        case 'func': {
          const map = stmt.method ? module.methods : module.functions;
          const list = map.get(stmt.name) ?? [];
          list.push({ stmt, module });
          map.set(stmt.name, list);
          break;
        }
        default:
          break;
      }
    }
    // Fields last: a field may be of a type declared further down.
    for (const stmt of statements) {
      if (stmt.kind !== 'typeDecl') continue;
      const def = module.types.get(stmt.name) as TypeDef;
      const seen = new Set<string>();
      for (const field of stmt.fields) {
        if (seen.has(field.name))
          this.fail(`The field "${field.name}" is declared twice`, field.span);
        seen.add(field.name);
        def.fields.push({
          name: field.name,
          type: this.resolveType(field.type, field.span, module),
          default: field.default,
          varip: field.varip,
        });
      }
    }
  }

  private importLibrary(into: Module, stmt: Extract<Stmt, { kind: 'import' }>): void {
    const path = `${stmt.publisher}/${stmt.library}/${stmt.version}`;
    if (into.imports.has(stmt.alias)) {
      this.fail(`The alias "${stmt.alias}" is already used`, stmt.span);
    }
    let module = this.modules.get(path);
    if (!module) {
      const source = this.options.resolveLibrary?.(stmt.publisher, stmt.library, stmt.version);
      if (source == null) {
        this.fail(
          `Could not find library "${path}". Add it in the Pine Editor with "Add library…": paste the library's code from its TradingView page.`,
          stmt.span,
        );
      }
      let script = parsedLibraries.get(source);
      if (!script) {
        try {
          script = upgrade(parse(source));
        } catch (error) {
          if (error instanceof PineCompileError) {
            this.fail(`The library "${path}" has an error: ${error.message}`, stmt.span);
          }
          throw error;
        }
        parsedLibraries.set(source, script);
      }
      if (!script.statements.some(isLibraryDeclaration)) {
        this.fail(`"${path}" isn't a library: its code must declare library()`, stmt.span);
      }
      module = new Module(path, versionOf(script), new Scope(null, 'global'));
      this.modules.set(path, module);
      const outer = this.module;
      this.module = module;
      try {
        this.declareAll(module, script.statements);
      } catch (error) {
        if (error instanceof PineCompileError && !error.message.startsWith('The library')) {
          this.fail(`The library "${path}" has an error: ${error.message}`, stmt.span);
        }
        throw error;
      } finally {
        this.module = outer;
      }
    }
    into.imports.set(stmt.alias, module);
  }

  /**
   * A written type as a type key: fundamental and drawing types as they are, collections with
   * their elements' keys, user-defined types and enums by their key, a library's by its alias.
   */
  resolveType(ref: TypeRef, span: Span, module: Module = this.module): Base {
    const name = genericName(ref);
    const args = typeArgs(ref);
    if (args.length > 0) {
      const resolved = args.map((arg) => this.resolveType(arg, span, module));
      if (name === 'array' || name === 'matrix') {
        if (resolved.length !== 1) this.fail(`"${name}" takes one type in <>`, span);
        return `${name}<${resolved[0]}>`;
      }
      if (name === 'map') {
        if (resolved.length !== 2) this.fail('"map" takes two types in <>', span);
        return `map<${resolved[0]}, ${resolved[1]}>`;
      }
      return this.fail(`"${name}" doesn't take types in <>`, span);
    }
    if (BUILTIN_TYPES.has(ref)) return ref;
    const own = module.types.get(ref) ?? module.enums.get(ref);
    if (own) return own.key;
    const dot = ref.indexOf('.');
    if (dot > 0) {
      const lib = module.imports.get(ref.slice(0, dot));
      const member = ref.slice(dot + 1);
      const def = lib?.types.get(member) ?? lib?.enums.get(member);
      if (def) {
        if (!def.exported) this.fail(`"${ref}" isn't exported by its library`, span);
        return def.key;
      }
    }
    return this.fail(`Unknown type "${ref}"`, span);
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
    const message = `Cannot call '${fn}' with argument '${param}'='${this.text(c.span)}'. An argument of '${typeName(c)}' type was used but a '${want} ${displayType(base)}' is expected.`;
    // v5 and older let some series values through (v6 migration guide: "Mutable variables are
    // always series"): scripts TradingView ran then run here, with a warning.
    if (this.version <= 5) {
      this.warn(message, c.span);
      return;
    }
    this.fail(message, c.span);
  }

  /** A type error for an argument. */
  needType(c: Compiled, ok: boolean, fn: string, param: string, want: string): void {
    if (ok) return;
    this.fail(
      `Cannot call '${fn}' with argument '${param}'='${this.text(c.span)}'. An argument of '${typeName(c)}' type was used but a '${want}' is expected.`,
      c.span,
    );
  }

  /** Marks the script as making collections or objects (a correction then runs it afresh). */
  usesObjects(): void {
    this.rt.usesObjects = true;
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

  private static readonly NOTHING: CompiledBlock = { run: () => null, base: 'void', qual: CONST };

  private statement(stmt: Stmt, scope: Scope): CompiledBlock {
    switch (stmt.kind) {
      case 'decl':
        return this.declaration(stmt, scope);
      case 'tupleDecl':
        return this.tupleDeclaration(stmt, scope);
      case 'assign':
        return this.assignment(stmt, scope);
      case 'func':
      case 'typeDecl':
      case 'enumDecl':
      case 'import':
        if (!scope.global) {
          this.fail('This can only be declared in the global scope', stmt.span);
        }
        return Compiler.NOTHING;
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
    if (isReferenceType(base)) this.usesObjects();
    const floor = this.floors.get(key) ?? CONST;
    const v: Var = {
      base,
      qual: maxQual(qual, floor),
      slot: this.rt.slot(mode, this.history.has(name), isNumericSlot(base)),
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
      const declared = this.resolveType(stmt.type, stmt.nameSpan);
      if (!this.assignableTo(value.base, declared)) {
        this.fail(
          `Cannot assign a value of type '${displayType(value.base)}' to the variable "${stmt.name}" of type '${displayType(declared)}'`,
          stmt.value.span,
        );
      }
      base = declared;
    } else if (value.base === 'na') {
      // v3 and older inferred the type from later assignments; float is what they nearly
      // always are (v4 guide: Explicit variable type declaration).
      if (this.version <= 3) base = 'float';
      else
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

  /** Assignable, leniently: an int array may stand for a float array (their values are numbers). */
  private assignableTo(from: Base, to: Base): boolean {
    if (assignable(from, to)) return true;
    const widened = from.replace(/\bint\b/g, 'float');
    return widened === to;
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
      const item = value.items?.[i] ?? 'float';
      const base = item === 'na' ? 'float' : item;
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
    const target = stmt.target;
    // A field: `obj.x := …`, `this.count += 1`, `(get()).x := …`.
    if (target.kind === 'member' || (target.kind === 'name' && target.name.includes('.'))) {
      const parts =
        target.kind === 'name'
          ? {
              object: this.dotted(
                target.name.slice(0, target.name.lastIndexOf('.')),
                target.span,
                scope,
              ),
              field: target.name.slice(target.name.lastIndexOf('.') + 1),
            }
          : { object: this.expr(target.target, scope), field: target.name };
      if (parts.object === null) {
        return this.fail(
          `Undeclared identifier "${(target as { name: string }).name}"`,
          target.span,
        );
      }
      return this.fieldAssignment(parts.object, parts.field, stmt, scope);
    }
    if (target.kind !== 'name')
      return this.fail('Only a variable or a field can be assigned', target.span);
    const name = target.name;
    const v = scope.lookup(name);
    if (!v) this.fail(`Undeclared identifier "${name}"`, target.span);
    if (v.isConst) this.fail(`"${name}" is const: it can't be reassigned`, target.span);
    const value = this.expr(stmt.value, scope);
    // A variable reassigned inside a block, or a var reassigned at all, changes from bar to bar:
    // it's a series from then on; elsewhere it takes the value's qualifier (Pine docs, Qualifiers).
    this.raise(v.key, scope.global && !v.slot.mode ? value.qual : SERIES);
    const slot = v.slot;
    if (stmt.op === ':=') {
      if (!this.assignableTo(value.base, v.base)) {
        this.fail(
          `Cannot assign a value of type '${displayType(value.base)}' to the variable "${name}" of type '${displayType(v.base)}'`,
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
      span: target.span,
    };
    const combined = this.binary(op, left, value, stmt.span);
    if (!assignable(combined.base, v.base)) {
      this.fail(
        `"${name}" is '${displayType(v.base)}': ${stmt.op} would make it '${displayType(combined.base)}'`,
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

  private fieldAssignment(
    object: Compiled,
    fieldName: string,
    stmt: Extract<Stmt, { kind: 'assign' }>,
    scope: Scope,
  ): CompiledBlock {
    const { def, index } = this.field(object, fieldName, stmt.target.span);
    const field = def.fields[index] as TypeDef['fields'][number];
    const value = this.expr(stmt.value, scope);
    const obj = object.ev;
    let next: (rt: Runtime, o: PineObject) => Value;
    if (stmt.op === ':=') {
      if (!this.assignableTo(value.base, field.type)) {
        this.fail(
          `Cannot assign a value of type '${displayType(value.base)}' to the field "${fieldName}" of type '${displayType(field.type)}'`,
          stmt.value.span,
        );
      }
      const cast = castTo(value, field.type);
      next = (rt) => cast(rt);
    } else {
      let current: PineObject | null = null;
      const left: Compiled = {
        base: field.type,
        qual: SERIES,
        ev: () => (current as PineObject).fields[index] ?? naOf(field.type),
        span: stmt.target.span,
      };
      const combined = this.binary(stmt.op.slice(0, 1), left, value, stmt.span);
      next = (rt, o) => {
        current = o;
        return combined.ev(rt);
      };
    }
    const span = stmt.target.span;
    return {
      run: (rt) => {
        const o = obj(rt) as PineObject | null;
        if (!o) throw naObject(fieldName, span);
        const value = next(rt, o);
        const old = o.fields[index] as Value;
        o.fields[index] = value;
        rt.record(() => {
          o.fields[index] = old;
        });
        return value;
      },
      base: field.type,
      qual: SERIES,
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
          literal: true,
        };
      }
      case 'string': {
        const value = expr.value;
        return {
          base: 'string',
          qual: CONST,
          ev: () => value,
          fold: () => value,
          span: expr.span,
          literal: true,
        };
      }
      case 'bool': {
        const value = expr.value;
        return {
          base: 'bool',
          qual: CONST,
          ev: () => value,
          fold: () => value,
          span: expr.span,
          literal: true,
        };
      }
      case 'color': {
        const value = expr.value;
        return {
          base: 'color',
          qual: CONST,
          ev: () => value,
          fold: () => value,
          span: expr.span,
          literal: true,
        };
      }
      case 'na':
        return {
          base: 'na',
          qual: CONST,
          ev: () => Number.NaN,
          fold: () => Number.NaN,
          span: expr.span,
          literal: true,
        };
      case 'compiled':
        return expr.compiled as Compiled;
      case 'name':
        return this.name(expr, scope);
      case 'member':
        return this.member(this.expr(expr.target, scope), expr.name, expr.span);
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
      case 'forIn':
        return this.forInLoop(expr, scope);
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

  private variable(v: Var, span: Span): Compiled {
    const slot = v.slot;
    const base = v.base;
    const na = naOf(base);
    return {
      base,
      qual: v.qual,
      ev: base === 'bool' ? () => slot.get() === true : () => slot.get() ?? na,
      fold: v.qual <= INPUT ? (env) => this.foldVar(v, env) : undefined,
      span,
    };
  }

  private name(expr: Extract<Expr, { kind: 'name' }>, scope: Scope): Compiled {
    const resolved = this.dotted(expr.name, expr.span, scope);
    if (resolved) return resolved;
    if (this.findFunctions(expr.name).length > 0) {
      return this.fail(`"${expr.name}" is a function: call it with ()`, expr.span);
    }
    return this.fail(`Undeclared identifier "${expr.name}"`, expr.span);
  }

  /**
   * A dotted name's value: a variable and its fields (`p.x`), an enum's member (`Dir.up`,
   * `lib.Dir.up`), or a built-in (`close`, `color.red`); null when it's none of these.
   */
  private dotted(name: string, span: Span, scope: Scope): Compiled | null {
    const parts = name.split('.');
    const first = parts[0] as string;
    const v = scope.lookup(first);
    // A variable, and its fields when it's an object (old scripts name variables `color`, and
    // `color.green` is still the built-in).
    if (v && (parts.length === 1 || this.types.has(v.base))) {
      let value = this.variable(v, span);
      for (const field of parts.slice(1)) value = this.member(value, field, span);
      return value;
    }
    const member = this.enumMember(parts, span);
    if (member) return member;
    return compileBuiltinName(this, name, span);
  }

  private enumMember(parts: readonly string[], span: Span): Compiled | null {
    let def: EnumDef | undefined;
    let rest: readonly string[];
    const lib = this.module.imports.get(parts[0] as string);
    if (lib && parts.length >= 3) {
      def = lib.enums.get(parts[1] as string);
      if (def && !def.exported) this.fail(`"${parts[1]}" isn't exported by its library`, span);
      rest = parts.slice(2);
    } else {
      def = this.module.enums.get(parts[0] as string);
      rest = parts.slice(1);
    }
    if (!def) return null;
    if (rest.length !== 1) return this.fail(`Write an enum's member as ${def.name}.<member>`, span);
    const value = def.members.find((m) => m.name === rest[0]);
    if (!value) return this.fail(`"${rest[0]}" isn't a member of the enum "${def.name}"`, span);
    return {
      base: def.key,
      qual: CONST,
      ev: () => value,
      fold: () => value,
      span,
      literal: true,
    };
  }

  /** The type and index of a field of an object's type. */
  private field(object: Compiled, name: string, span: Span): { def: TypeDef; index: number } {
    const def = this.types.get(object.base);
    if (!def) {
      return this.fail(
        `Cannot access the field "${name}": '${displayType(object.base)}' has no fields`,
        span,
      );
    }
    const index = def.fields.findIndex((field) => field.name === name);
    if (index < 0) return this.fail(`"${def.name}" has no field "${name}"`, span);
    return { def, index };
  }

  /** `object.field`: a runtime error when the object is na, as Pine's. */
  member(object: Compiled, name: string, span: Span): Compiled {
    const { def, index } = this.field(object, name, span);
    const type = (def.fields[index] as TypeDef['fields'][number]).type;
    const obj = object.ev;
    const na = naOf(type);
    return {
      base: type,
      qual: SERIES,
      ev: (rt) => {
        const o = obj(rt) as PineObject | null;
        if (!o) throw naObject(name, span);
        const value = o.fields[index];
        return value === undefined || value === null ? na : value;
      },
      span,
    };
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

  /** A value where a bool is needed: v5 and older cast numbers (0 and na are false). */
  toBool(c: Compiled): Compiled {
    if (c.base === 'bool') return c;
    if (c.base === 'na') return { ...c, base: 'bool', ev: () => false, fold: () => false };
    if (this.version <= 5 && isNumeric(c.base)) {
      const ev = c.ev;
      const fold = c.fold;
      const cast = (x: Value) => !Number.isNaN(x as number) && x !== 0;
      return {
        ...c,
        base: 'bool',
        ev: (rt) => cast(ev(rt)),
        fold: fold && ((env) => cast(fold(env))),
      };
    }
    return c;
  }

  private unary(expr: Extract<Expr, { kind: 'unary' }>, scope: Scope): Compiled {
    let operand = this.expr(expr.operand, scope);
    if (expr.op === 'not') {
      operand = this.toBool(operand);
      if (operand.base !== 'bool') {
        this.fail(`Cannot apply "not" to '${typeName(operand)}': it needs a bool`, expr.span);
      }
      const ev = operand.ev;
      const fold = operand.fold;
      return {
        base: 'bool',
        qual: operand.qual,
        ev: (rt) => !(ev(rt) as boolean),
        fold: fold && ((env) => !(fold(env) as boolean)),
        span: expr.span,
      };
    }
    const ev = operand.ev;
    const fold = operand.fold;
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

  /** `and` and `or`: lazy in v6, both sides always evaluated before (v6 migration guide). */
  private logical(
    op: 'and' | 'or',
    leftRaw: Compiled,
    rightExpr: Expr,
    scope: Scope,
    span: Span,
  ): Compiled {
    const left = this.toBool(leftRaw);
    const right = this.toBool(this.expr(rightExpr, scope));
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
    const eager = this.version <= 5;
    if (op === 'and') {
      return {
        base: 'bool',
        qual,
        ev: eager
          ? (rt) => {
              const x = a(rt) as boolean;
              const y = b(rt) as boolean;
              return x && y;
            }
          : (rt) => (a(rt) as boolean) && (b(rt) as boolean),
        fold: fa && fb && ((env) => (fa(env) as boolean) && (fb(env) as boolean)),
        span,
      };
    }
    return {
      base: 'bool',
      qual,
      ev: eager
        ? (rt) => {
            const x = a(rt) as boolean;
            const y = b(rt) as boolean;
            return x || y;
          }
        : (rt) => (a(rt) as boolean) || (b(rt) as boolean),
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
        // An na piece adds nothing: the na string is "" (measured on TradingView, strings.ts).
        ...both((x, y) => naText(x) + naText(y)),
        span,
      };
    }
    if (op === '==' || op === '!=') {
      const unified = unify(left.base, right.base);
      if (!unified || unified === 'tuple' || unified === 'void') {
        this.fail(`Cannot compare '${typeName(left)}' with '${typeName(right)}'`, span);
      }
      if (isReferenceType(unified)) {
        // Objects, collections and enum members compare by identity; na by being na.
        const eq = (x: Value, y: Value) => norm(x) === norm(y);
        const ne = (x: Value, y: Value) => norm(x) !== norm(y);
        return { base: 'bool', qual, ...both(op === '==' ? eq : ne), span };
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
        // v5 and older divided two const ints as integers (v6 guide: Fractional division of
        // constants); otherwise division by zero is na and ints divide to a fraction.
        if (this.version <= 5 && ints && qual === CONST) {
          return {
            base: 'int',
            qual,
            ev: (rt) => intDivide(x(rt), y(rt)),
            fold: both((p, q) => intDivide(p as number, q as number)).fold,
            span,
          };
        }
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
        `The two sides of ?: must have the same type, but one is '${displayType(then.base)}' and the other '${displayType(otherwise.base)}'`,
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

  /** A condition must be a bool (v5 and older cast numbers); na counts as false. */
  condition(raw: Compiled): Compiled {
    const c = this.toBool(raw);
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
    if (offset.base !== 'int' && !(this.version <= 5 && offset.base === 'float')) {
      this.fail(`The [] offset must be an int, but this is '${typeName(offset)}'`, offset.span);
    }
    const k = offset.ev;
    if (expr.target.kind === 'name' && !expr.target.name.includes('.')) {
      const v = scope.lookup(expr.target.name);
      if (v) {
        const slot = v.slot;
        const base = v.base;
        const na = naOf(base);
        return {
          base,
          qual: SERIES,
          ev: (rt) => {
            const n = Math.floor(k(rt) as number);
            if (!(n >= 0)) throw historyError(n, expr.span);
            const value = slot.back(n);
            return value === undefined || value === null ? na : value;
          },
          span: expr.span,
        };
      }
    }
    if (expr.target.kind === 'name') {
      // Built-in series by name, dotted ones too (ta.obv[24]), unless the first part is one of
      // the script's own variables (an object's field).
      const name = expr.target.name;
      const dot = name.indexOf('.');
      if (dot < 0 || !scope.lookup(name.slice(0, dot))) {
        const builtin = compileHistoryOfBuiltin(this, name, offset, expr.span);
        if (builtin) return builtin;
      }
    }
    // An expression's or a call's history: kept in a hidden variable of its own.
    const target = this.expr(expr.target, scope);
    if (target.base === 'tuple' || target.base === 'void') {
      this.fail(`Cannot use [] on '${target.base}'`, expr.span);
    }
    if (target.literal && this.version >= 6) {
      this.fail(
        'The [] operator cannot be used on a literal or a built-in constant (Pine v6)',
        expr.span,
      );
    }
    const slot = this.rt.slot(null, true, isNumericSlot(target.base));
    const ev = target.ev;
    const na = naOf(target.base);
    return {
      base: target.base,
      qual: SERIES,
      ev: (rt) => {
        slot.push(ev(rt));
        const n = Math.floor(k(rt) as number);
        if (!(n >= 0)) throw historyError(n, expr.span);
        const value = slot.back(n);
        return value === undefined || value === null ? na : value;
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
    this.rt.loopDepth = this.loops;
    const body = this.statements(expr.body.statements, inner);
    this.loops--;
    this.rt.loopDepth = this.loops;
    const f = from.ev;
    const t = to.ev;
    const s = step?.ev ?? (() => 1);
    const slot = counter.slot;
    const run = body.run;
    const empty = naOf(body.base);
    // v6 reads the end before every iteration; v5 and older once (v6 guide: Dynamic for loop
    // boundaries).
    const dynamicEnd = this.version >= 6;
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
          const end = dynamicEnd ? (t(rt) as number) : firstTo;
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

  /**
   * `for x in collection`, `for [i, x] in array`, `for [key, value] in map`, `for row in
   * matrix` (Pine docs, Loops): the collection as it is when each iteration starts.
   */
  private forInLoop(expr: Extract<Expr, { kind: 'forIn' }>, scope: Scope): Compiled {
    const target = this.expr(expr.target, scope);
    const base = target.base;
    const inner = new Scope(scope, 'local');
    const [first, second] = expr.names;
    const span0 = expr.nameSpans[0] as Span;
    let itemBase: Base;
    let keyBase: Base | null = null;
    if (isArrayType(base)) {
      itemBase = elemOf(base);
      if (second !== undefined) keyBase = 'int';
    } else if (isMatrixType(base)) {
      itemBase = `array<${elemOf(base)}>`;
      if (second !== undefined) keyBase = 'int';
    } else if (isMapType(base)) {
      const [k, v] = typeArgs(base) as [Base, Base];
      if (second === undefined) {
        return this.fail('A map is looped through with for [key, value] in …', expr.span);
      }
      keyBase = k;
      itemBase = v;
    } else {
      return this.fail(
        `for…in loops through arrays, matrices and maps, not '${displayType(base)}'`,
        target.span,
      );
    }
    if (expr.names.length > 2) this.fail('for…in takes one or two names', expr.span);
    const keySlot =
      keyBase !== null
        ? this.define(
            inner,
            first as string,
            span0,
            keyBase,
            SERIES,
            stableKey(expr, 0),
            null,
            false,
          ).slot
        : null;
    const itemName = second ?? (first as string);
    const itemSpan = (second !== undefined ? expr.nameSpans[1] : span0) as Span;
    const itemSlot = this.define(
      inner,
      itemName,
      itemSpan,
      itemBase,
      SERIES,
      stableKey(expr, 1),
      null,
      false,
    ).slot;
    this.loops++;
    this.rt.loopDepth = this.loops;
    const body = this.statements(expr.body.statements, inner);
    this.loops--;
    this.rt.loopDepth = this.loops;
    const run = body.run;
    const collection = target.ev;
    const empty = naOf(body.base);
    const elem = elemOf(base);
    const step = (rt: Runtime, key: Value, item: Value): number => {
      keySlot?.push(key);
      itemSlot.push(item);
      rt.tick();
      run(rt);
      if (rt.signal === 1) {
        rt.signal = 0;
        return 1;
      }
      rt.signal = 0;
      return 0;
    };
    let ev: (rt: Runtime) => Value;
    if (isArrayType(base)) {
      ev = (rt) => {
        const array = collection(rt) as PineArray | null;
        if (!array) return empty;
        for (let i = 0; i < array.items.length; i++) {
          if (step(rt, i, array.items[i] ?? null) === 1) break;
        }
        return empty;
      };
    } else if (isMatrixType(base)) {
      ev = (rt) => {
        const m = collection(rt) as PineMatrix | null;
        if (!m) return empty;
        for (let r = 0; r < m.rows; r++) {
          const row = new PineArray(elem, m.data.slice(r * m.cols, (r + 1) * m.cols));
          if (step(rt, r, row) === 1) break;
        }
        return empty;
      };
    } else {
      ev = (rt) => {
        const m = collection(rt) as PineMap | null;
        if (!m) return empty;
        for (const [key, value] of [...m.entries]) {
          if (step(rt, key, value) === 1) break;
        }
        return empty;
      };
    }
    return { base: 'void', qual: SERIES, ev, span: expr.span };
  }

  private whileLoop(expr: Extract<Expr, { kind: 'while' }>, scope: Scope): Compiled {
    const cond = this.condition(this.expr(expr.cond, scope)).ev;
    this.loops++;
    this.rt.loopDepth = this.loops;
    const body = this.block(expr.body, scope);
    this.loops--;
    this.rt.loopDepth = this.loops;
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
    if (OUTPUT_ONLY_GLOBAL.has(expr.callee) && !expr.receiver && !scope.global) {
      this.fail(
        `Cannot call '${expr.callee}' inside a local block or a function: only in the script's global scope`,
        expr.calleeSpan,
      );
    }
    // A method on any value: `arr.get(0).copy()`.
    if (expr.receiver) {
      return this.methodCall(this.expr(expr.receiver, scope), expr.callee, expr, scope);
    }
    const parts = expr.callee.split('.');
    const first = parts[0] as string;
    if (parts.length > 1) {
      // A method on a variable or its fields: `arr.push(x)`, `p.pos.move()`.
      const v = scope.lookup(first);
      if (v && this.hasMethods(v.base, parts.at(-1) as string)) {
        const receiver = this.dotted(parts.slice(0, -1).join('.'), expr.calleeSpan, scope);
        if (receiver) return this.methodCall(receiver, parts.at(-1) as string, expr, scope);
      }
      // A user method on a built-in value: `close.msma(5)`, `ta.tr.half()` (Pine docs, Methods).
      const method = parts.at(-1) as string;
      if (!v && !isBuiltinNamespace(expr.callee) && this.findMethods(method).length > 0) {
        const receiver = compileBuiltinName(this, parts.slice(0, -1).join('.'), expr.calleeSpan);
        if (receiver) return this.methodCall(receiver, method, expr, scope);
      }
      // A type's constructor or copy: `Point.new(…)`, `lib.Point.new(…)`.
      const typeCall = this.typeCall(parts, expr, scope);
      if (typeCall) return typeCall;
      // A library's function: `lib.fn(…)`.
      const lib = this.module.imports.get(first);
      if (lib && parts.length === 2) {
        const fns = (lib.functions.get(parts[1] as string) ?? []).filter((fn) => fn.stmt.exported);
        if (fns.length === 0) {
          this.fail(
            `The library "${first}" doesn't export a function "${parts[1]}"`,
            expr.calleeSpan,
          );
        }
        return this.userCall(fns, expr, scope, null);
      }
    } else {
      const own = this.findFunctions(first);
      if (own.length > 0) return this.userCall(own, expr, scope, null);
    }
    return compileCall(this, expr, scope);
  }

  /** Values a method of this name can be called on: collections, objects, drawings, user methods. */
  private hasMethods(base: Base, name: string): boolean {
    return (
      isArrayType(base) ||
      isMatrixType(base) ||
      isMapType(base) ||
      this.types.has(base) ||
      DRAWING_TYPES.has(base) ||
      this.findMethods(name).length > 0
    );
  }

  /** The functions a plain name calls in the module being compiled. */
  private findFunctions(name: string): FuncDef[] {
    return this.module.functions.get(name) ?? [];
  }

  private typeCall(
    parts: readonly string[],
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
  ): Compiled | null {
    let def: TypeDef | undefined;
    let method: string;
    const lib = this.module.imports.get(parts[0] as string);
    if (lib && parts.length === 3) {
      def = lib.types.get(parts[1] as string);
      if (def && !def.exported)
        this.fail(`"${parts[1]}" isn't exported by its library`, expr.calleeSpan);
      method = parts[2] as string;
    } else if (parts.length === 2) {
      def = this.module.types.get(parts[0] as string);
      method = parts[1] as string;
    } else {
      return null;
    }
    if (!def) return null;
    if (method === 'new') return this.construct(def, expr, scope);
    if (method === 'copy') {
      const arg = expr.args[0];
      if (!arg || expr.args.length !== 1)
        this.fail(`${def.name}.copy() takes the object to copy`, expr.span);
      const object = this.expr(arg.value, scope);
      if (object.base !== def.key) {
        this.fail(
          `${def.name}.copy() takes a ${def.name}, not '${displayType(object.base)}'`,
          arg.span,
        );
      }
      return copyObject(object, expr.span);
    }
    // A method declared for the type, called on the type with the object first.
    return this.fail(
      `"${def.name}.${method}" isn't something a type has: use new() or copy()`,
      expr.calleeSpan,
    );
  }

  /** `T.new(…)`: the fields from the arguments by position or name, the rest their defaults. */
  private construct(def: TypeDef, expr: Extract<Expr, { kind: 'call' }>, scope: Scope): Compiled {
    this.usesObjects();
    const values: (Compiled | null)[] = def.fields.map(() => null);
    let position = 0;
    for (const arg of expr.args) {
      let i: number;
      if (arg.name === null) {
        if (position >= def.fields.length) {
          this.fail(`Too many arguments for ${def.name}.new()`, arg.span);
        }
        i = position++;
      } else {
        i = def.fields.findIndex((field) => field.name === arg.name);
        if (i < 0) this.fail(`"${def.name}" has no field "${arg.name}"`, arg.span);
      }
      const field = def.fields[i] as TypeDef['fields'][number];
      const value = this.expr(arg.value, scope);
      if (!this.assignableTo(value.base, field.type)) {
        this.fail(
          `Cannot set the field "${field.name}" of type '${displayType(field.type)}' to '${displayType(value.base)}'`,
          arg.span,
        );
      }
      values[i] = value;
    }
    const outer = this.module;
    this.module = def.module;
    const evs = def.fields.map((field, i) => {
      const given = values[i];
      if (given) return castTo(given, field.type);
      if (!field.default) {
        const na = naOf(field.type);
        return () => na;
      }
      const fallback = this.expr(field.default, def.module.scope);
      if (!this.assignableTo(fallback.base, field.type)) {
        this.fail(
          `The default of the field "${field.name}" must be '${displayType(field.type)}'`,
          field.default.span,
        );
      }
      return castTo(fallback, field.type);
    });
    this.module = outer;
    const key = def.key;
    return {
      base: key,
      qual: SERIES,
      ev: (rt) =>
        new PineObject(
          key,
          evs.map((ev) => ev(rt)),
        ),
      span: expr.span,
    };
  }

  /**
   * A method called on a value: a user method declared for its type (here or in an imported
   * library), a built-in one of its collection or drawing type, or an object's copy().
   */
  private methodCall(
    receiver: Compiled,
    name: string,
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
  ): Compiled {
    const candidates = this.findMethods(name).filter((fn) => {
      const first = fn.stmt.params[0] as Param;
      if (!first.type) return true;
      const type = this.resolveTypeSafe(first.type, fn.module);
      return type !== null && this.assignableTo(receiver.base, type);
    });
    if (candidates.length > 0) return this.userCall(candidates, expr, scope, receiver);
    if (this.types.has(receiver.base) && name === 'copy' && expr.args.length === 0) {
      return copyObject(receiver, expr.span);
    }
    const space = methodNamespace(receiver.base);
    if (space && isBuiltinNamespace(`${space}.${name}`)) {
      const call: Extract<Expr, { kind: 'call' }> = {
        ...expr,
        callee: `${space}.${name}`,
        receiver: null,
        args: [
          {
            name: null,
            value: { kind: 'compiled', compiled: receiver, span: receiver.span },
            span: receiver.span,
          },
          ...expr.args,
        ],
      };
      return compileCall(this, call, scope);
    }
    return this.fail(
      `Could not find method or method reference '${name}' for '${displayType(receiver.base)}'`,
      expr.calleeSpan,
    );
  }

  /** User methods by name: the module's own, and those its libraries export. */
  private findMethods(name: string): FuncDef[] {
    const own = this.module.methods.get(name) ?? [];
    const imported = [...this.module.imports.values()].flatMap((lib) =>
      (lib.methods.get(name) ?? []).filter((fn) => fn.stmt.exported),
    );
    return [...own, ...imported];
  }

  private resolveTypeSafe(ref: TypeRef, module: Module): Base | null {
    try {
      return this.resolveType(ref, { line: 1, column: 1, endLine: 1, endColumn: 2 }, module);
    } catch {
      return null;
    }
  }

  /**
   * A user function's (or method's) call: the overload whose parameters take the arguments,
   * then a copy of its body with its own history for this call (Pine docs, User-defined
   * functions).
   */
  private userCall(
    candidates: readonly FuncDef[],
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
    receiver: Compiled | null,
  ): Compiled {
    const positional: Compiled[] = receiver ? [receiver] : [];
    const named = new Map<string, { value: Compiled; span: Span }>();
    for (const arg of expr.args) {
      const value = this.expr(arg.value, scope);
      if (arg.name === null) positional.push(value);
      else {
        if (named.has(arg.name) && this.version >= 6) {
          this.fail(`The '${arg.name}' argument is given twice`, arg.span);
        }
        if (!named.has(arg.name)) named.set(arg.name, { value, span: arg.span });
      }
    }
    let firstError: PineCompileError | null = null;
    for (const fn of candidates) {
      try {
        const args = this.bindUserArgs(fn, positional, named, expr);
        return this.inline(fn, args, expr);
      } catch (error) {
        if (!(error instanceof PineCompileError) || candidates.length === 1) throw error;
        firstError ??= error;
      }
    }
    throw firstError as PineCompileError;
  }

  private bindUserArgs(
    fn: FuncDef,
    positional: readonly Compiled[],
    named: ReadonlyMap<string, { value: Compiled; span: Span }>,
    expr: Extract<Expr, { kind: 'call' }>,
  ): Compiled[] {
    const params = fn.stmt.params;
    const name = fn.stmt.name;
    if (positional.length > params.length) {
      this.fail(`Too many arguments in the call to "${name}"`, expr.span);
    }
    const bound: (Compiled | undefined)[] = params.map((_, i) => positional[i]);
    for (const [argName, { value, span }] of named) {
      const i = params.findIndex((param) => param.name === argName);
      if (i < 0) this.fail(`"${name}" has no parameter "${argName}"`, span);
      if (bound[i]) this.fail(`The '${argName}' argument is given twice`, span);
      bound[i] = value;
    }
    return params.map((param, i) => {
      const value = bound[i];
      if (value) {
        if (param.type) {
          const type = this.resolveType(param.type, param.span, fn.module);
          if (!this.assignableTo(value.base, type)) {
            this.fail(
              `Cannot call '${name}' with argument '${param.name}'='${this.text(value.span)}'. An argument of '${typeName(value)}' type was used but a '${displayType(type)}' is expected.`,
              value.span,
            );
          }
        }
        return value;
      }
      if (!param.default) {
        this.fail(`Missing the "${param.name}" argument in the call to "${name}"`, expr.span);
      }
      const outer = this.module;
      this.module = fn.module;
      try {
        return this.expr(param.default, fn.module.scope);
      } finally {
        this.module = outer;
      }
    });
  }

  private inline(
    fn: FuncDef,
    args: readonly Compiled[],
    expr: Extract<Expr, { kind: 'call' }>,
  ): Compiled {
    const stmt = fn.stmt;
    const id = `${fn.module.key}/${stmt.name}`;
    if (this.calling.includes(id)) {
      this.fail(
        `Recursive calls aren't allowed in Pine: "${stmt.name}" calls itself`,
        expr.calleeSpan,
      );
    }
    const outer = this.module;
    this.module = fn.module;
    const fnScope = new Scope(fn.module.scope, 'function');
    const params = stmt.params.map((param, i) => {
      const arg = args[i] as Compiled;
      const declared = param.type ? this.resolveType(param.type, param.span, fn.module) : null;
      const base = declared ?? (arg.base === 'na' ? 'float' : arg.base);
      if (param.qualifier === 'simple' || param.qualifier === 'const') {
        this.needQual(
          arg,
          param.qualifier === 'const' ? CONST : SIMPLE,
          stmt.name,
          param.name,
          base,
        );
      }
      const qual = param.qualifier === 'series' ? SERIES : arg.qual;
      const key = stableKey(param, expr);
      const v = this.define(fnScope, param.name, param.span, base, qual, key, null, false);
      if (arg.fold) this.registerFold(key, arg.fold);
      return { slot: v.slot, ev: castTo(arg, base) };
    });
    this.calling.push(id);
    // A function's body is its own: a loop around the call doesn't let it break.
    const loops = this.loops;
    this.loops = 0;
    let body: CompiledBlock;
    try {
      body = this.blockValueOfFunction(stmt.body, fnScope);
    } finally {
      this.loops = loops;
      this.calling.pop();
      this.module = outer;
    }
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
}

/** `obj.copy()`, `T.copy(obj)`: a new object with the same field values (Pine docs, Objects). */
function copyObject(object: Compiled, span: Span): Compiled {
  const ev = object.ev;
  return {
    base: object.base,
    qual: SERIES,
    ev: (rt) => {
      const o = ev(rt) as PineObject | null;
      return o ? new PineObject(o.type, [...o.fields]) : null;
    },
    span,
  };
}

const isLibraryDeclaration = (stmt: Stmt) =>
  stmt.kind === 'expr' && stmt.expr.kind === 'call' && stmt.expr.callee === 'library';

/** An enum member's title: its string, or its name when none is given. */
function enumTitle(title: Expr | null, name: string): string {
  return title?.kind === 'string' ? title.value : name;
}

/** na as null, for comparing objects and enum members (NaN is na too). */
const norm = (x: Value): Value => (typeof x === 'number' && Number.isNaN(x) ? null : x);

const divide = (x: number, y: number) => (y === 0 ? Number.NaN : x / y);
const intDivide = (x: number, y: number) => (y === 0 ? Number.NaN : Math.trunc(x / y));
// The Pine docs' own formula, a - b * math.floor(nz(a / b)): so x % 0 is x.
const remainder = (x: number, y: number) => (y === 0 ? x : mod(x, y));

function historyError(n: number, span: Span): PineRuntimeError {
  return new PineRuntimeError(
    `Invalid history reference [${Number.isNaN(n) ? 'na' : n}]: the offset must be 0 or more`,
    span,
  );
}

function naObject(field: string, span: Span): PineRuntimeError {
  return new PineRuntimeError(
    `Cannot access the field "${field}" of an object that is na: create it with .new() first`,
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

/** A string operand: na (the na literal, or a string that's na) is "". */
const naText = (value: Value): string => (typeof value === 'string' ? value : '');
