import type { Arg, Expr } from './ast.ts';
import type { Compiler, Scope } from './compiler.ts';
import type { Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import {
  type Base,
  CONST,
  type Compiled,
  type FoldEnv,
  INPUT,
  isNumeric,
  QUAL_NAMES,
  type Qual,
  SERIES,
  SIMPLE,
} from './types.ts';
import type { Value } from './values.ts';

export type Call = Extract<Expr, { kind: 'call' }>;
export type Fold = (env: FoldEnv) => Value;
export type Ev = (rt: Runtime) => Value;
export type NumEv = (rt: Runtime) => number;
export type Handler = (c: Compiler, call: Call, scope: Scope) => Compiled;

export const constant = (base: Base, value: Value, span: Span): Compiled => ({
  base,
  qual: CONST,
  ev: () => value,
  fold: () => value,
  span,
  literal: true,
});

export const simple = (base: Base, read: (rt: Runtime) => Value, span: Span): Compiled => ({
  base,
  qual: SIMPLE,
  ev: read,
  span,
});

export const series = (base: Base, read: (rt: Runtime) => Value, span: Span): Compiled => ({
  base,
  qual: SERIES,
  ev: read,
  span,
});

// ---- arguments ----

/**
 * The call's arguments by parameter: positional ones in order, then named ones (the v6
 * reference's signatures). Unknown names, repeats and missing required ones are errors.
 */
export function bind(
  c: Compiler,
  call: Call,
  names: readonly string[],
  required: number,
): (Arg | undefined)[] {
  const fn = call.callee;
  const bound: (Arg | undefined)[] = names.map(() => undefined);
  let position = 0;
  for (const arg of call.args) {
    let i: number;
    if (arg.name === null) {
      if (position >= names.length) c.fail(`Too many arguments in the call to '${fn}'`, arg.span);
      i = position++;
    } else {
      i = names.indexOf(arg.name);
      if (i < 0) c.fail(`'${fn}' has no parameter '${arg.name}'`, arg.span);
    }
    if (bound[i]) {
      const message = `The '${names[i]}' argument is given twice in the call to '${fn}'`;
      // v5 and older used the first and warned (v6 guide: Cannot repeat parameters).
      if (c.version <= 5) {
        c.warn(message, arg.span);
        continue;
      }
      c.fail(message, arg.span);
    }
    bound[i] = arg;
  }
  for (let i = 0; i < required; i++) {
    if (!bound[i]) c.fail(`Missing the '${names[i]}' argument in the call to '${fn}'`, call.span);
  }
  return bound;
}

export class Args {
  private readonly c: Compiler;
  private readonly call: Call;
  private readonly scope: Scope;
  private readonly names: readonly string[];
  private readonly bound: (Arg | undefined)[];
  private readonly cache = new Map<number, Compiled>();

  constructor(c: Compiler, call: Call, scope: Scope, names: readonly string[], required: number) {
    this.c = c;
    this.call = call;
    this.scope = scope;
    this.names = names;
    this.bound = bind(c, call, names, required);
  }

  get fn(): string {
    return this.call.callee;
  }

  has(name: string): boolean {
    return this.bound[this.index(name)] !== undefined;
  }

  raw(name: string): Arg | undefined {
    return this.bound[this.index(name)];
  }

  private index(name: string): number {
    const i = this.names.indexOf(name);
    if (i < 0) throw new Error(`No parameter ${name} in ${this.fn}`);
    return i;
  }

  /** The argument compiled, or undefined when not given. */
  get(name: string): Compiled | undefined {
    const i = this.index(name);
    const arg = this.bound[i];
    if (!arg) return undefined;
    let compiled = this.cache.get(i);
    if (!compiled) {
      compiled = this.c.expr(arg.value, this.scope);
      this.cache.set(i, compiled);
    }
    return compiled;
  }

  private check(
    name: string,
    ok: (base: Base) => boolean,
    want: string,
    max: Qual,
  ): Compiled | undefined {
    const value = this.get(name);
    if (!value) return undefined;
    this.c.needType(value, ok(value.base), this.fn, name, want);
    this.c.needQual(value, max, this.fn, name, want.split(' ').at(-1) as Base);
    return value;
  }

  number(name: string, max: Qual = SERIES): NumEv | undefined {
    const value = this.check(name, isNumeric, qualWord(max, 'float'), max);
    return value?.ev as NumEv | undefined;
  }

  int(name: string, max: Qual = SERIES): NumEv | undefined {
    const value = this.check(name, (b) => b === 'int' || b === 'na', qualWord(max, 'int'), max);
    return value?.ev as NumEv | undefined;
  }

  bool(name: string, max: Qual = SERIES): ((rt: Runtime) => boolean) | undefined {
    const value = this.check(name, (b) => b === 'bool' || b === 'na', qualWord(max, 'bool'), max);
    return value?.ev as ((rt: Runtime) => boolean) | undefined;
  }

  color(name: string, max: Qual = SERIES): Compiled | undefined {
    return this.check(name, (b) => b === 'color' || b === 'na', qualWord(max, 'color'), max);
  }

  string(name: string, max: Qual = SERIES): Compiled | undefined {
    return this.check(name, (b) => b === 'string' || b === 'na', qualWord(max, 'string'), max);
  }

  /**
   * A const or input argument (const only when `max` says so), worked out from the inputs before
   * the bars; the default when not given.
   */
  folded(name: string, fallback: Value, check?: (c: Compiled) => void, max: Qual = INPUT): Fold {
    const value = this.get(name);
    if (!value) return () => fallback;
    check?.(value);
    this.c.needQual(value, max, this.fn, name, value.base);
    if (!value.fold) {
      if (!this.c.strict) return () => fallback;
      return this.c.fail(
        `The '${name}' argument of '${this.fn}' must be known before the script runs (const or input)`,
        value.span,
      );
    }
    return value.fold;
  }

  /** A const or input argument of one type: Pine's "input int", "const bool", "input plot_style". */
  foldedAs(name: string, base: Base, fallback: Value, max: Qual = INPUT): Fold {
    const check = (value: Compiled) => {
      const ok =
        value.base === base || value.base === 'na' || (base === 'float' && value.base === 'int');
      this.c.needType(value, ok, this.fn, name, `${QUAL_NAMES[max]} ${base}`);
    };
    return this.folded(name, fallback, check, max);
  }

  /** A const argument (titles, an input's settings). */
  constant(name: string, fallback: Value, base: Base | null = null): Value {
    const value = this.get(name);
    if (!value) return fallback;
    if (base)
      this.c.needType(
        value,
        value.base === base || value.base === 'na' || (base === 'float' && value.base === 'int'),
        this.fn,
        name,
        `const ${base}`,
      );
    this.c.needQual(value, CONST, this.fn, name, value.base);
    if (!value.fold) {
      if (!this.c.strict) return fallback;
      return this.c.fail(`The '${name}' argument of '${this.fn}' must be a constant`, value.span);
    }
    return value.fold({ inputs: [] });
  }

  get span(): Span {
    return this.call.span;
  }
}

export const qualWord = (max: Qual, base: string) => `${QUAL_NAMES[max]} ${base}`;
