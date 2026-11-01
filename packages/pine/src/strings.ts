import { Args, type Call, type Handler } from './args.ts';
import type { Compiler, Scope } from './compiler.ts';
import { PineRuntimeError } from './diagnostics.ts';
import {
  FORMAT_NAMES,
  type FormatArg,
  floatToString,
  formatMessage,
  formatNumber,
  javaDouble,
  parseNumber,
} from './format.ts';
import type { Runtime } from './runtime.ts';
import { formatUtc } from './timeBuiltins.ts';
import {
  type Base,
  CONST,
  type Compiled,
  elemOf,
  type FoldEnv,
  isArrayType,
  isMatrixType,
  maxQual,
  SERIES,
} from './types.ts';
import { PineArray, PineMatrix, type Value } from './values.ts';

/**
 * Pine's strings (the v6 reference's str.* functions, log.* and alert()). An na string is the
 * empty one, as on TradingView: `"a" + na` is "a" and na("") is true (measured by PineTS on
 * TradingView, third-party: docs/SPEC.md §4.17).
 */

/** A string argument's value: na is "". */
export const text = (value: Value | undefined): string =>
  typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);

/** How str.tostring() writes one value of a type, with a format or without. */
export function toText(value: Value, base: Base, format: string | null, mintick: number): string {
  if (value === null || value === undefined) return base === 'string' ? '' : 'NaN';
  if (typeof value === 'number') {
    if (format !== null && format !== '' && (base === 'float' || base === 'int' || base === 'na'))
      return formatNumber(value, format, mintick);
    if (Number.isNaN(value)) return 'NaN';
    return base === 'int' ? String(value) : floatToString(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (value instanceof PineArray) {
    const elem = elemOf(base) ?? value.elem;
    return `[${value.items.map((item) => toText(item, elem, format, mintick)).join(', ')}]`;
  }
  if (value instanceof PineMatrix) {
    const elem = elemOf(base) ?? value.elem;
    const rows: string[] = [];
    for (let r = 0; r < value.rows; r++) {
      const row: string[] = [];
      for (let col = 0; col < value.cols; col++)
        row.push(toText(value.data[r * value.cols + col] ?? null, elem, format, mintick));
      rows.push(`[${row.join(', ')}]`);
    }
    // One row per line (provisional: docs/SPEC.md §11).
    return rows.join('\n');
  }
  return String(value);
}

/** A str.format() argument as format.ts takes it. */
function formatArg(value: Value, base: Base): FormatArg {
  if (value instanceof PineArray) return { value: value.items, type: base };
  return { value, type: base };
}

/** A str.* call on strings (and numbers) whose result is worked out from its arguments. */
function pure(
  names: readonly string[],
  required: number,
  result: Base,
  kinds: readonly ('string' | 'int' | 'any')[],
  f: (values: (Value | undefined)[], rt: Runtime | null) => Value,
): Handler {
  return (c, call, scope) => {
    const args = new Args(c, call, scope, names, required);
    const compiled = names.map((name, i) => {
      const kind = kinds[i];
      if (kind === 'string') return args.string(name);
      if (kind === 'int') {
        const value = args.get(name);
        if (value) args.number(name);
        return value;
      }
      return args.get(name);
    });
    const evs = compiled.map((value) => value?.ev ?? (() => undefined));
    const folds = compiled.map((value) => (value ? value.fold : () => undefined));
    const given = compiled.filter((value): value is Compiled => value !== undefined);
    const canFold = folds.every((fold) => fold !== undefined);
    return {
      base: result,
      qual: given.length > 0 ? maxQual(...given.map((value) => value.qual)) : CONST,
      ev: (rt) =>
        f(
          evs.map((ev) => ev(rt)),
          rt,
        ),
      fold: canFold
        ? (env) =>
            f(
              folds.map((fold) => (fold as (env: FoldEnv) => Value)(env)),
              null,
            )
        : undefined,
      span: call.span,
    };
  };
}

const index = (value: Value | undefined): number => Math.floor(Number(value));

/** A space or a control character, which str.trim() takes off both ends (the v6 reference). */
const isBlank = (code: number) =>
  code <= 32 || code === 0x7f || /\s/.test(String.fromCharCode(code));

function trimText(source: string): string {
  let start = 0;
  let end = source.length;
  while (start < end && isBlank(source.charCodeAt(start))) start++;
  while (end > start && isBlank(source.charCodeAt(end - 1))) end--;
  return source.slice(start, end);
}

/** str.replace()'s nth occurrence (0 = the first). */
function replaceNth(source: string, target: string, replacement: string, nth: number): string {
  if (target === '') return source;
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = source.indexOf(target, at + (i === 0 ? 0 : target.length));
    if (at < 0) return source;
  }
  return source.slice(0, at) + replacement + source.slice(at + target.length);
}

const regexes = new Map<string, RegExp | null>();

function regexOf(pattern: string): RegExp | null {
  let regex = regexes.get(pattern);
  if (regex === undefined) {
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = null;
    }
    regexes.set(pattern, regex);
  }
  return regex;
}

/** The variadic str.format(formatString, arg0, arg1 …) and log.*(message, args …). */
function formatted(c: Compiler, call: Call, scope: Scope, nameOfPattern: string) {
  const patternArg = call.args.find((arg) => arg.name === nameOfPattern) ?? call.args[0];
  if (!patternArg) {
    return c.fail(
      `Missing the '${nameOfPattern}' argument in the call to '${call.callee}'`,
      call.span,
    );
  }
  const pattern = c.expr(patternArg.value, scope);
  c.needType(pattern, pattern.base === 'string', call.callee, nameOfPattern, 'series string');
  const rest = call.args.filter((arg) => arg !== patternArg);
  if (rest.some((arg) => arg.name !== null)) {
    c.fail(`'${call.callee}' takes its values after the format, without names`, call.span);
  }
  const values = rest.map((arg) => c.expr(arg.value, scope));
  for (const value of values) {
    if (value.base === 'void' || value.base === 'tuple')
      c.fail(`'${call.callee}' can't format a value of this type`, value.span);
  }
  const patternEv = pattern.ev;
  const evs = values.map((value) => value.ev);
  const bases = values.map((value) => value.base);
  const write = (patternValue: Value | undefined, argValues: Value[]) => {
    const text = typeof patternValue === 'string' ? patternValue : '';
    // A message without values is written as it is (measured: log.info("bad { 0 }")).
    if (argValues.length === 0 && call.callee.startsWith('log.')) return text;
    return formatMessage(
      text,
      argValues.map((value, i) => formatArg(value, bases[i] as Base)),
      formatUtc,
    );
  };
  const folds = [pattern, ...values].map((value) => value.fold);
  return {
    pattern,
    values,
    qual: maxQual(pattern.qual, ...values.map((value) => value.qual)),
    ev: (rt: Runtime) =>
      write(
        patternEv(rt),
        evs.map((ev) => ev(rt)),
      ),
    fold: folds.every((fold) => fold !== undefined)
      ? (env: FoldEnv) => {
          const [p, ...rest] = folds.map((fold) => (fold as (env: FoldEnv) => Value)(env));
          return write(p ?? '', rest);
        }
      : undefined,
  };
}

function logCall(level: 'info' | 'warning' | 'error'): Handler {
  return (c, call, scope) => {
    const message = formatted(c, call, scope, 'message');
    const ev = message.ev;
    return {
      base: 'void',
      qual: SERIES,
      ev: (rt) => {
        rt.log(level, ev(rt));
        return null;
      },
      span: call.span,
    };
  };
}

export function stringCalls(): Record<string, Handler> {
  return {
    'str.tostring': (c, call, scope) => {
      const args = new Args(c, call, scope, ['value', 'format'], 1);
      const value = args.get('value') as Compiled;
      if (
        value.base === 'void' ||
        value.base === 'tuple' ||
        value.base === 'color' ||
        (!isArrayType(value.base) &&
          !isMatrixType(value.base) &&
          !['int', 'float', 'bool', 'string', 'na'].includes(value.base))
      ) {
        c.fail(`str.tostring() can't write a value of type '${value.base}'`, value.span);
      }
      const format = args.string('format');
      const ev = value.ev;
      const formatEv = format?.ev;
      const base = value.base;
      const write = (v: Value, f: Value | undefined, mintick: number) =>
        toText(v, base, f === undefined || f === null ? null : String(f), mintick);
      // Worked out before the bars when it can be: not with format.mintick, which needs the
      // symbol's tick.
      const constFormat =
        format?.fold && format.qual === CONST ? format.fold({ inputs: [] }) : null;
      const valueFold = value.fold;
      const foldable =
        valueFold && (!format || (format.qual === CONST && constFormat !== 'mintick'));
      return {
        base: 'string',
        qual: maxQual(value.qual, format?.qual ?? CONST),
        ev: (rt) => write(ev(rt), formatEv?.(rt), rt.symbol.mintick),
        fold: foldable
          ? (env) =>
              write((valueFold as (env: FoldEnv) => Value)(env), constFormat ?? undefined, 0.01)
          : undefined,
        span: call.span,
      };
    },
    'str.tonumber': pure(['string'], 1, 'float', ['string'], ([s]) => parseNumber(text(s))),
    'str.length': pure(['string'], 1, 'int', ['string'], ([s]) => text(s).length),
    'str.lower': pure(['source'], 1, 'string', ['string'], ([s]) => text(s).toLowerCase()),
    'str.upper': pure(['source'], 1, 'string', ['string'], ([s]) => text(s).toUpperCase()),
    'str.trim': pure(['source'], 1, 'string', ['string'], ([s]) => trimText(text(s))),
    'str.contains': pure(['source', 'str'], 2, 'bool', ['string', 'string'], ([s, t]) =>
      text(s).includes(text(t)),
    ),
    'str.startswith': pure(['source', 'str'], 2, 'bool', ['string', 'string'], ([s, t]) =>
      text(s).startsWith(text(t)),
    ),
    'str.endswith': pure(['source', 'str'], 2, 'bool', ['string', 'string'], ([s, t]) =>
      text(s).endsWith(text(t)),
    ),
    'str.pos': pure(['source', 'str'], 2, 'int', ['string', 'string'], ([s, t]) => {
      const at = text(s).indexOf(text(t));
      return at < 0 ? Number.NaN : at;
    }),
    'str.substring': pure(
      ['source', 'begin_pos', 'end_pos'],
      2,
      'string',
      ['string', 'int', 'int'],
      ([s, begin, end]) => {
        const source = text(s);
        const from = index(begin);
        const to = end === undefined ? source.length : index(end);
        if (!(from >= 0 && from <= source.length) || !(to >= from && to <= source.length)) {
          throw new PineRuntimeError(
            `The substring's positions (${from}, ${to}) are outside the string "${source}" (length ${source.length})`,
          );
        }
        return source.slice(from, to);
      },
    ),
    'str.replace': pure(
      ['source', 'target', 'replacement', 'occurrence'],
      3,
      'string',
      ['string', 'string', 'string', 'int'],
      ([s, t, r, n]) => replaceNth(text(s), text(t), text(r), n === undefined ? 0 : index(n)),
    ),
    'str.replace_all': pure(
      ['source', 'target', 'replacement'],
      3,
      'string',
      ['string', 'string', 'string'],
      ([s, t, r]) => (text(t) === '' ? text(s) : text(s).split(text(t)).join(text(r))),
    ),
    'str.repeat': pure(
      ['source', 'repeat', 'separator'],
      2,
      'string',
      ['string', 'int', 'string'],
      ([s, n, sep]) => {
        const times = index(n);
        if (!(times >= 0)) {
          throw new PineRuntimeError(
            `str.repeat() needs a repeat count of 0 or more, not ${String(n)}`,
          );
        }
        return Array.from({ length: times }, () => text(s)).join(text(sep));
      },
    ),
    'str.match': pure(['source', 'regex'], 2, 'string', ['string', 'string'], ([s, r]) => {
      const regex = regexOf(text(r));
      if (!regex) throw new PineRuntimeError(`Invalid regular expression "${text(r)}"`);
      return regex.exec(text(s))?.[0] ?? '';
    }),
    'str.split': (c, call, scope) => {
      const args = new Args(c, call, scope, ['string', 'separator'], 2);
      const s = (args.string('string') as Compiled).ev;
      const sep = (args.string('separator') as Compiled).ev;
      return {
        base: 'array<string>',
        qual: SERIES,
        ev: (rt) => {
          rt.usesObjects = true;
          const separator = text(sep(rt));
          const source = text(s(rt));
          // An empty separator splits into characters (Pine FAQ: split a string into characters).
          return new PineArray('string', separator === '' ? [...source] : source.split(separator));
        },
        span: call.span,
      };
    },
    'str.format': (c, call, scope) => {
      const message = formatted(c, call, scope, 'formatString');
      return {
        base: 'string',
        qual: message.qual,
        ev: message.ev,
        fold: message.fold,
        span: call.span,
      };
    },
    'log.info': logCall('info'),
    'log.warning': logCall('warning'),
    'log.error': logCall('error'),
    // Alerts come with the alerts dialog: until then an alert() call does nothing, as on a
    // TradingView chart without an alert set on the script.
    alert: (c, call, scope) => {
      const args = new Args(c, call, scope, ['message', 'freq'], 1);
      args.string('message');
      args.string('freq');
      return { base: 'void', qual: SERIES, ev: () => null, span: call.span };
    },
  };
}

/** array.join() writes floats as Java's Double.toString does ("5.0", "1.0E8"; measured). */
export function joinText(value: Value, elem: string): string {
  if (value === null || value === undefined) return elem === 'string' ? '' : 'NaN';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    return elem === 'float' ? javaDouble(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export { FORMAT_NAMES };
