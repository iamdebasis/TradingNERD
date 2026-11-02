import { Args, type Call, type Handler, series } from './args.ts';
import type { Compiler, Scope } from './compiler.ts';
import { PineRuntimeError, type Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import { joinText } from './strings.ts';
import {
  arrayOf,
  assignable,
  type Base,
  type Compiled,
  displayType,
  elemOf,
  isArrayType,
  isMapType,
  isMatrixType,
  isNumeric,
  isReferenceType,
  mapOf,
  matrixOf,
  naOf,
  typeArgs,
  unify,
} from './types.ts';
import { PineArray, PineMap, PineMatrix, type Value } from './values.ts';

/**
 * Pine's arrays, maps and matrices (the v6 reference's array.*, map.* and matrix.*; Pine docs,
 * Arrays, Maps and Matrices). A change on the live bar saves the collection first, so the next
 * update rolls it back as it does variables (Runtime.touch).
 */

type Ev<T> = (rt: Runtime) => T;

const fail = (message: string, span: Span): never => {
  throw new PineRuntimeError(message, span);
};

/** Saves an array's elements before it changes on the live bar. */
/** An array's most elements (Arrays, Error handling: "Array is too large. Maximum size is 100000"). */
export const MAX_ARRAY = 100_000;

/** Stops when an array would grow past the most elements it may hold. */
const roomFor = (a: PineArray, more: number, span: Span) => {
  if (a.items.length + more > MAX_ARRAY) fail('Array is too large. Maximum size is 100000', span);
};

const touchArray = (rt: Runtime, a: PineArray) =>
  rt.touch(a, () => {
    const items = a.items.slice();
    return () => {
      a.items = items;
    };
  });

const touchMap = (rt: Runtime, m: PineMap) =>
  rt.touch(m, () => {
    const entries = [...m.entries];
    return () => {
      m.entries.clear();
      for (const [k, v] of entries) m.entries.set(k, v);
    };
  });

const touchMatrix = (rt: Runtime, m: PineMatrix) =>
  rt.touch(m, () => {
    const { rows, cols } = m;
    const data = m.data.slice();
    return () => {
      m.rows = rows;
      m.cols = cols;
      m.data = data;
    };
  });

/** Numbers in a collection, na left out (Pine's statistics skip na). */
const numbers = (items: readonly Value[]): number[] =>
  items.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));

/** Equality as Pine compares elements: numbers by value (na never equal), the rest by identity. */
const same = (a: Value, b: Value) =>
  typeof a === 'number' ? a === b : a !== null && b !== null && a === b;

// ---- argument helpers ----

interface CollectionArg<T> {
  ev: Ev<T>;
  base: Base;
  c: Compiled;
}

function collection<T>(
  c: Compiler,
  args: Args,
  name: string,
  is: (base: Base) => boolean,
  what: string,
  span: Span,
): CollectionArg<T> {
  const value = args.get(name) as Compiled;
  if (!is(value.base)) {
    c.fail(
      `Cannot call '${args.fn}' with argument '${name}'='${c.text(value.span)}': it takes ${what}, not '${displayType(value.base)}'`,
      value.span,
    );
  }
  const ev = value.ev;
  const fn = args.fn;
  // An array's and a matrix's are TradingView's own messages (Arrays, Matrices: Error handling).
  const naMessage =
    what === 'an array'
      ? "Cannot call array methods when ID of array is 'na'"
      : what === 'a matrix'
        ? "Cannot call matrix methods when the ID of matrix is 'na'."
        : `Cannot call '${fn}' on a collection that is na`;
  return {
    base: value.base,
    c: value,
    ev: (rt) => {
      const v = ev(rt);
      if (v === null) return fail(naMessage, span);
      return v as T;
    },
  };
}

const arrayArg = (c: Compiler, args: Args, name: string, span: Span) =>
  collection<PineArray>(c, args, name, isArrayType, 'an array', span);
const mapArg = (c: Compiler, args: Args, name: string, span: Span) =>
  collection<PineMap>(c, args, name, isMapType, 'a map', span);
const matrixArg = (c: Compiler, args: Args, name: string, span: Span) =>
  collection<PineMatrix>(c, args, name, isMatrixType, 'a matrix', span);

/** A value going into a collection of `elem`s: of that type (an int where floats go). */
function valueArg(c: Compiler, args: Args, name: string, elem: Base): Ev<Value> | undefined {
  const value = args.get(name);
  if (!value) return undefined;
  const ok =
    assignable(value.base, elem) ||
    (elem === 'float' && value.base === 'int') ||
    value.base === elem;
  c.needType(value, ok, args.fn, name, displayType(elem));
  if (value.base === 'na') {
    const na = naOf(elem);
    return () => na;
  }
  return value.ev;
}

function intArg(args: Args, name: string): Ev<number> | undefined {
  return args.int(name) as Ev<number> | undefined;
}

function numArg(args: Args, name: string): Ev<number> | undefined {
  return args.number(name) as Ev<number> | undefined;
}

/** An index into `size` elements; v6 counts negative ones from the end (v6 migration guide). */
function index(
  c: Compiler,
  raw: number,
  size: number,
  fn: string,
  span: Span,
  allowEnd = false,
): number {
  let i = Math.trunc(raw);
  if (Number.isNaN(i)) fail(`The index of '${fn}' is na`, span);
  if (i < 0 && c.version >= 6) i += size;
  const limit = allowEnd ? size : size - 1;
  if (i < 0 || i > limit) {
    fail(`Index ${Math.trunc(raw)} is out of bounds. Array size is ${size}`, span);
  }
  return i;
}

const handler =
  (
    names: readonly string[],
    required: number,
    build: (c: Compiler, a: Args, call: Call) => Compiled,
  ): Handler =>
  (c, call, scope) => {
    const args = new Args(c, call, scope, names, required);
    return build(c, args, call);
  };

// ---- arrays ----

function newArray(c: Compiler, call: Call, scope: Scope, elem: Base): Compiled {
  c.usesObjects();
  const args = new Args(c, call, scope, ['size', 'initial_value'], 0);
  const size = intArg(args, 'size') ?? (() => 0);
  const init = valueArg(c, args, 'initial_value', elem) ?? (() => naOf(elem));
  const span = call.span;
  return series(
    arrayOf(elem),
    (rt) => {
      const n = size(rt);
      // TradingView's own messages (Arrays, Error handling).
      if (n < 0) fail('Cannot create an array with a negative size', span);
      if (!(n >= 0)) fail("An array's size can't be na", span);
      if (n > MAX_ARRAY) fail('Array is too large. Maximum size is 100000', span);
      const value = init(rt);
      return new PineArray(elem, new Array(Math.trunc(n)).fill(value));
    },
    span,
  );
}

/** array.from(…): the elements' type is theirs (ints with floats are floats). */
function arrayFrom(c: Compiler, call: Call, scope: Scope): Compiled {
  c.usesObjects();
  if (call.args.some((arg) => arg.name !== null)) {
    c.fail('array.from() takes its values without names', call.span);
  }
  const values = call.args.map((arg) => c.expr(arg.value, scope));
  if (values.length === 0) c.fail('array.from() needs at least one value', call.span);
  let elem: Base = 'na';
  for (const value of values) {
    const next = unify(elem, value.base);
    if (!next) {
      c.fail(
        `array.from() takes values of one type, but here are '${displayType(elem)}' and '${displayType(value.base)}'`,
        value.span,
      );
    }
    elem = next;
  }
  if (elem === 'na') elem = 'float';
  const evs = values.map((value) => value.ev);
  return series(
    arrayOf(elem),
    (rt) =>
      new PineArray(
        elem,
        evs.map((ev) => ev(rt)),
      ),
    call.span,
  );
}

const numericElem = (c: Compiler, a: CollectionArg<unknown>, fn: string) => {
  const elem = elemOf(a.base);
  if (!isNumeric(elem))
    c.fail(`'${fn}' works on arrays of numbers, not '${displayType(a.base)}'`, a.c.span);
  return elem;
};

const mean = (xs: readonly number[]) =>
  xs.length === 0 ? Number.NaN : xs.reduce((s, x) => s + x, 0) / xs.length;

function variance(xs: readonly number[], biased: boolean): number {
  const n = xs.length;
  if (n === 0 || (!biased && n < 2)) return Number.NaN;
  const m = mean(xs);
  const sum = xs.reduce((s, x) => s + (x - m) ** 2, 0);
  return sum / (biased ? n : n - 1);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The most frequent value; the smallest of several (the v6 reference). */
function modeOf(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = Number.NaN;
  let bestCount = 0;
  for (const [x, n] of counts) {
    if (n > bestCount || (n === bestCount && x < best)) {
      best = x;
      bestCount = n;
    }
  }
  return best;
}

/** Linear interpolation between closest ranks (Pine's percentile_linear_interpolation). */
function percentileLinear(xs: readonly number[], percentage: number): number {
  if (xs.length === 0 || Number.isNaN(percentage)) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, percentage)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
}

/** The nearest-rank method (Pine's percentile_nearest_rank). */
function percentileNearest(xs: readonly number[], percentage: number): number {
  if (xs.length === 0 || Number.isNaN(percentage)) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const p = Math.min(100, Math.max(0, percentage));
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

const compareValues = (a: Value, b: Value) => {
  const na = (v: Value) => v === null || (typeof v === 'number' && Number.isNaN(v));
  if (na(a)) return na(b) ? 0 : 1;
  if (na(b)) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return (a as number) - (b as number);
};

/** order.ascending or order.descending, as the sort functions take it. */
function orderArg(c: Compiler, args: Args, name: string): Ev<boolean> {
  const value = args.get(name);
  if (!value) return () => true;
  c.needType(
    value,
    value.base === 'order_style',
    args.fn,
    name,
    'order.ascending or order.descending',
  );
  const ev = value.ev;
  return (rt) => ev(rt) !== 'descending';
}

/** Where `value` sits in a sorted array: found, or where it would go (Pine's binary searches). */
function binarySearch(
  items: readonly Value[],
  value: number,
  mode: 'exact' | 'left' | 'right',
): number {
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = items[mid] as number;
    if (x === value) {
      if (mode === 'exact') return mid;
      // the leftmost or rightmost equal element
      let i = mid;
      if (mode === 'left') while (i > 0 && items[i - 1] === value) i--;
      else while (i < items.length - 1 && items[i + 1] === value) i++;
      return i;
    }
    if (x < value) lo = mid + 1;
    else hi = mid - 1;
  }
  if (mode === 'exact') return -1;
  // Not found: the element just left (smaller) or just right (larger) of where it would be.
  return mode === 'left' ? hi : lo;
}

function arrayCalls(): Record<string, Handler> {
  const calls: Record<string, Handler> = {
    'array.new': (c, call, scope) => {
      const type = call.typeArgs?.[0];
      if (!type || call.typeArgs?.length !== 1) {
        return c.fail("array.new needs its elements' type: array.new<float>()", call.calleeSpan);
      }
      return newArray(c, call, scope, c.resolveType(type, call.calleeSpan));
    },
    'array.from': arrayFrom,
    'array.copy': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      return series(
        id.base,
        (rt) => {
          const x = id.ev(rt);
          return new PineArray(x.elem, x.items.slice());
        },
        call.span,
      );
    }),
    'array.size': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      return series('int', (rt) => id.ev(rt).items.length, call.span);
    }),
    'array.get': handler(['id', 'index'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const i = intArg(a, 'index') as Ev<number>;
      const elem = elemOf(id.base);
      return series(
        elem,
        (rt) => {
          const x = id.ev(rt);
          const at = i(rt);
          // An na index reads na: the manual's "Distance from high" (Arrays) runs on TradingView
          // with ta.highestbars na over its first bars (provisional, docs/SPEC.md §11).
          if (Number.isNaN(at)) return naOf(elem);
          return x.items[index(c, at, x.items.length, 'array.get', call.span)] ?? naOf(elem);
        },
        call.span,
      );
    }),
    'array.set': handler(['id', 'index', 'value'], 3, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const i = intArg(a, 'index') as Ev<number>;
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          const at = index(c, i(rt), x.items.length, 'array.set', call.span);
          touchArray(rt, x);
          x.items[at] = value(rt);
          return null;
        },
        call.span,
      );
    }),
    'array.first': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const elem = elemOf(id.base);
      return series(
        elem,
        (rt) => {
          const x = id.ev(rt);
          if (x.items.length === 0) fail("Cannot call 'array.first' on an empty array", call.span);
          return x.items[0] ?? naOf(elem);
        },
        call.span,
      );
    }),
    'array.last': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const elem = elemOf(id.base);
      return series(
        elem,
        (rt) => {
          const x = id.ev(rt);
          if (x.items.length === 0) fail("Cannot call 'array.last' on an empty array", call.span);
          return x.items[x.items.length - 1] ?? naOf(elem);
        },
        call.span,
      );
    }),
    'array.push': handler(['id', 'value'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          roomFor(x, 1, call.span);
          touchArray(rt, x);
          x.items.push(value(rt));
          return null;
        },
        call.span,
      );
    }),
    'array.unshift': handler(['id', 'value'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          roomFor(x, 1, call.span);
          touchArray(rt, x);
          x.items.unshift(value(rt));
          return null;
        },
        call.span,
      );
    }),
    'array.pop': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const elem = elemOf(id.base);
      return series(
        elem,
        (rt) => {
          const x = id.ev(rt);
          if (x.items.length === 0) fail('Cannot use pop() if array is empty.', call.span);
          touchArray(rt, x);
          return x.items.pop() ?? naOf(elem);
        },
        call.span,
      );
    }),
    'array.shift': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const elem = elemOf(id.base);
      return series(
        elem,
        (rt) => {
          const x = id.ev(rt);
          if (x.items.length === 0) fail('Cannot use shift() if array is empty.', call.span);
          touchArray(rt, x);
          return x.items.shift() ?? naOf(elem);
        },
        call.span,
      );
    }),
    'array.insert': handler(['id', 'index', 'value'], 3, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const i = intArg(a, 'index') as Ev<number>;
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          const at = index(c, i(rt), x.items.length, 'array.insert', call.span, true);
          roomFor(x, 1, call.span);
          touchArray(rt, x);
          x.items.splice(at, 0, value(rt));
          return null;
        },
        call.span,
      );
    }),
    'array.remove': handler(['id', 'index'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const i = intArg(a, 'index') as Ev<number>;
      const elem = elemOf(id.base);
      return series(
        elem,
        (rt) => {
          const x = id.ev(rt);
          const at = index(c, i(rt), x.items.length, 'array.remove', call.span);
          touchArray(rt, x);
          return x.items.splice(at, 1)[0] ?? naOf(elem);
        },
        call.span,
      );
    }),
    'array.clear': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          touchArray(rt, x);
          x.items = [];
          return null;
        },
        call.span,
      );
    }),
    'array.concat': handler(['id1', 'id2'], 2, (c, a, call) => {
      const id1 = arrayArg(c, a, 'id1', call.span);
      const id2 = arrayArg(c, a, 'id2', call.span);
      return series(
        id1.base,
        (rt) => {
          const x = id1.ev(rt);
          const y = id2.ev(rt);
          roomFor(x, y.items.length, call.span);
          touchArray(rt, x);
          x.items.push(...y.items);
          return x;
        },
        call.span,
      );
    }),
    'array.fill': handler(['id', 'value', 'index_from', 'index_to'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      const from = intArg(a, 'index_from') ?? (() => 0);
      const to = intArg(a, 'index_to');
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          const start = Math.max(0, from(rt));
          const end = to ? Math.min(x.items.length, to(rt)) : x.items.length;
          touchArray(rt, x);
          const v = value(rt);
          for (let i = start; i < end; i++) x.items[i] = v;
          return null;
        },
        call.span,
      );
    }),
    'array.reverse': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          touchArray(rt, x);
          x.items.reverse();
          return null;
        },
        call.span,
      );
    }),
    'array.sort': handler(['id', 'order'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const ascending = orderArg(c, a, 'order');
      return series(
        'void',
        (rt) => {
          const x = id.ev(rt);
          touchArray(rt, x);
          const up = ascending(rt);
          x.items.sort((p, q) => (up ? compareValues(p, q) : compareValues(q, p)));
          return null;
        },
        call.span,
      );
    }),
    'array.sort_indices': handler(['id', 'order'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const ascending = orderArg(c, a, 'order');
      c.usesObjects();
      return series(
        arrayOf('int'),
        (rt) => {
          const x = id.ev(rt);
          const up = ascending(rt);
          const order = x.items.map((_, i) => i);
          order.sort((p, q) => {
            const d = compareValues(x.items[p] ?? null, x.items[q] ?? null);
            return up ? d : -d;
          });
          return new PineArray('int', order);
        },
        call.span,
      );
    }),
    // A copy of the elements (provisional: Pine's slice shares them with the array, §11).
    'array.slice': handler(['id', 'index_from', 'index_to'], 3, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const from = intArg(a, 'index_from') as Ev<number>;
      const to = intArg(a, 'index_to') as Ev<number>;
      c.usesObjects();
      return series(
        id.base,
        (rt) => {
          const x = id.ev(rt);
          const start = index(c, from(rt), x.items.length, 'array.slice', call.span, true);
          const end = index(c, to(rt), x.items.length, 'array.slice', call.span, true);
          return new PineArray(x.elem, x.items.slice(start, end));
        },
        call.span,
      );
    }),
    'array.includes': handler(['id', 'value'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'bool',
        (rt) => {
          const v = value(rt);
          return id.ev(rt).items.some((x) => same(x, v));
        },
        call.span,
      );
    }),
    'array.indexof': handler(['id', 'value'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'int',
        (rt) => {
          const v = value(rt);
          return id.ev(rt).items.findIndex((x) => same(x, v));
        },
        call.span,
      );
    }),
    'array.lastindexof': handler(['id', 'value'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'int',
        (rt) => {
          const v = value(rt);
          return id.ev(rt).items.findLastIndex((x) => same(x, v));
        },
        call.span,
      );
    }),
    'array.join': handler(['id', 'separator'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      const separator = a.string('separator')?.ev ?? (() => '');
      return series(
        'string',
        (rt) => {
          const x = id.ev(rt);
          return x.items.map((item) => joinText(item, x.elem)).join(String(separator(rt) ?? ''));
        },
        call.span,
      );
    }),
    'array.every': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      return series(
        'bool',
        (rt) =>
          id
            .ev(rt)
            .items.every(
              (x) => x === true || (typeof x === 'number' && x !== 0 && !Number.isNaN(x)),
            ),
        call.span,
      );
    }),
    'array.some': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      return series(
        'bool',
        (rt) =>
          id
            .ev(rt)
            .items.some(
              (x) => x === true || (typeof x === 'number' && x !== 0 && !Number.isNaN(x)),
            ),
        call.span,
      );
    }),
    'array.abs': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      numericElem(c, id, 'array.abs');
      c.usesObjects();
      return series(
        id.base,
        (rt) => {
          const x = id.ev(rt);
          return new PineArray(
            x.elem,
            x.items.map((v) => Math.abs(v as number)),
          );
        },
        call.span,
      );
    }),
    'array.standardize': handler(['id'], 1, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      numericElem(c, id, 'array.standardize');
      c.usesObjects();
      return series(
        arrayOf('float'),
        (rt) => {
          const x = id.ev(rt);
          const xs = numbers(x.items);
          const m = mean(xs);
          const sd = Math.sqrt(variance(xs, true));
          return new PineArray(
            'float',
            x.items.map((v) => ((v as number) - m) / sd),
          );
        },
        call.span,
      );
    }),
    'array.binary_search': searchCall('exact'),
    'array.binary_search_leftmost': searchCall('left'),
    'array.binary_search_rightmost': searchCall('right'),
    'array.min': nthCall('array.min', false),
    'array.max': nthCall('array.max', true),
    'array.sum': statCall('array.sum', 'same', (xs) => xs.reduce((s, x) => s + x, 0)),
    'array.avg': statCall('array.avg', 'float', mean),
    'array.median': statCall('array.median', 'float', median),
    'array.mode': statCall('array.mode', 'same', modeOf),
    'array.range': statCall('array.range', 'same', (xs) =>
      xs.length === 0 ? Number.NaN : Math.max(...xs) - Math.min(...xs),
    ),
    'array.stdev': biasedCall('array.stdev', (xs, biased) => Math.sqrt(variance(xs, biased))),
    'array.variance': biasedCall('array.variance', variance),
    'array.covariance': handler(['id1', 'id2', 'biased'], 2, (c, a, call) => {
      const id1 = arrayArg(c, a, 'id1', call.span);
      const id2 = arrayArg(c, a, 'id2', call.span);
      numericElem(c, id1, 'array.covariance');
      numericElem(c, id2, 'array.covariance');
      const biased = a.bool('biased') ?? (() => true);
      return series(
        'float',
        (rt) => {
          const xs = id1.ev(rt).items as number[];
          const ys = id2.ev(rt).items as number[];
          const n = Math.min(xs.length, ys.length);
          if (n === 0) return Number.NaN;
          const mx = mean(xs.slice(0, n));
          const my = mean(ys.slice(0, n));
          let sum = 0;
          for (let i = 0; i < n; i++) sum += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
          const b = biased(rt);
          return n - (b ? 0 : 1) <= 0 ? Number.NaN : sum / (b ? n : n - 1);
        },
        call.span,
      );
    }),
    'array.percentile_linear_interpolation': percentileCall(
      'array.percentile_linear_interpolation',
      percentileLinear,
    ),
    'array.percentile_nearest_rank': percentileCall(
      'array.percentile_nearest_rank',
      percentileNearest,
    ),
    // The share of the other elements at or below this one, in percent (provisional, §11).
    'array.percentrank': handler(['id', 'index'], 2, (c, a, call) => {
      const id = arrayArg(c, a, 'id', call.span);
      numericElem(c, id, 'array.percentrank');
      const i = intArg(a, 'index') as Ev<number>;
      return series(
        'float',
        (rt) => {
          const x = id.ev(rt);
          const at = index(c, i(rt), x.items.length, 'array.percentrank', call.span);
          const value = x.items[at] as number;
          if (x.items.length < 2 || Number.isNaN(value)) return Number.NaN;
          let count = 0;
          x.items.forEach((v, j) => {
            if (j !== at && (v as number) <= value) count++;
          });
          return (count / (x.items.length - 1)) * 100;
        },
        call.span,
      );
    }),
  };
  for (const [suffix, elem] of [
    ['float', 'float'],
    ['int', 'int'],
    ['bool', 'bool'],
    ['color', 'color'],
    ['string', 'string'],
    ['label', 'label'],
    ['line', 'line'],
    ['box', 'box'],
    ['table', 'table'],
    ['linefill', 'linefill'],
  ] as const) {
    calls[`array.new_${suffix}`] = (c, call, scope) => newArray(c, call, scope, elem);
  }
  return calls;
}

function searchCall(mode: 'exact' | 'left' | 'right'): Handler {
  return handler(['id', 'val'], 2, (c, a, call) => {
    const id = arrayArg(c, a, 'id', call.span);
    numericElem(c, id, a.fn);
    const value = numArg(a, 'val') as Ev<number>;
    return series('int', (rt) => binarySearch(id.ev(rt).items, value(rt), mode), call.span);
  });
}

function nthCall(fn: string, largest: boolean): Handler {
  return handler(['id', 'nth'], 1, (c, a, call) => {
    const id = arrayArg(c, a, 'id', call.span);
    const elem = numericElem(c, id, fn);
    const nth = intArg(a, 'nth') ?? (() => 0);
    return series(
      elem,
      (rt) => {
        const xs = numbers(id.ev(rt).items).sort((p, q) => (largest ? q - p : p - q));
        const n = Math.trunc(nth(rt));
        return n >= 0 && n < xs.length ? (xs[n] as number) : Number.NaN;
      },
      call.span,
    );
  });
}

function statCall(fn: string, result: 'same' | 'float', f: (xs: number[]) => number): Handler {
  return handler(['id'], 1, (c, a, call) => {
    const id = arrayArg(c, a, 'id', call.span);
    const elem = numericElem(c, id, fn);
    return series(
      result === 'same' ? elem : 'float',
      (rt) => f(numbers(id.ev(rt).items)),
      call.span,
    );
  });
}

function biasedCall(fn: string, f: (xs: number[], biased: boolean) => number): Handler {
  return handler(['id', 'biased'], 1, (c, a, call) => {
    const id = arrayArg(c, a, 'id', call.span);
    numericElem(c, id, fn);
    const biased = a.bool('biased') ?? (() => true);
    return series('float', (rt) => f(numbers(id.ev(rt).items), biased(rt)), call.span);
  });
}

function percentileCall(fn: string, f: (xs: number[], p: number) => number): Handler {
  return handler(['id', 'percentage'], 2, (c, a, call) => {
    const id = arrayArg(c, a, 'id', call.span);
    numericElem(c, id, fn);
    const percentage = numArg(a, 'percentage') as Ev<number>;
    return series('float', (rt) => f(numbers(id.ev(rt).items), percentage(rt)), call.span);
  });
}

// ---- maps ----

const MAP_KEYS: ReadonlySet<string> = new Set(['int', 'float', 'bool', 'color', 'string']);

function mapCalls(): Record<string, Handler> {
  return {
    'map.new': (c, call, scope) => {
      const types = call.typeArgs;
      if (types?.length !== 2) {
        return c.fail(
          "map.new needs its keys' and values' types: map.new<string, float>()",
          call.calleeSpan,
        );
      }
      new Args(c, call, scope, [], 0);
      const key = c.resolveType(types[0] as string, call.calleeSpan);
      const value = c.resolveType(types[1] as string, call.calleeSpan);
      if (!MAP_KEYS.has(key) && !c.enums.has(key)) {
        c.fail(
          `A map's keys must be int, float, bool, color, string or an enum, not '${displayType(key)}'`,
          call.calleeSpan,
        );
      }
      c.usesObjects();
      return series(mapOf(key, value), () => new PineMap(key, value), call.span);
    },
    'map.put': handler(['id', 'key', 'value'], 3, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      const [k, v] = typeArgs(id.base) as [Base, Base];
      const key = valueArg(c, a, 'key', k) as Ev<Value>;
      const value = valueArg(c, a, 'value', v) as Ev<Value>;
      return series(
        v,
        (rt) => {
          const m = id.ev(rt);
          const kk = key(rt);
          const before = m.entries.has(kk) ? (m.entries.get(kk) as Value) : naOf(v);
          touchMap(rt, m);
          m.entries.set(kk, value(rt));
          return before;
        },
        call.span,
      );
    }),
    'map.get': handler(['id', 'key'], 2, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      const [k, v] = typeArgs(id.base) as [Base, Base];
      const key = valueArg(c, a, 'key', k) as Ev<Value>;
      const na = naOf(v);
      return series(
        v,
        (rt) => {
          const m = id.ev(rt);
          const kk = key(rt);
          return m.entries.has(kk) ? (m.entries.get(kk) as Value) : na;
        },
        call.span,
      );
    }),
    'map.contains': handler(['id', 'key'], 2, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      const [k] = typeArgs(id.base) as [Base];
      const key = valueArg(c, a, 'key', k) as Ev<Value>;
      return series('bool', (rt) => id.ev(rt).entries.has(key(rt)), call.span);
    }),
    'map.remove': handler(['id', 'key'], 2, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      const [k, v] = typeArgs(id.base) as [Base, Base];
      const key = valueArg(c, a, 'key', k) as Ev<Value>;
      return series(
        v,
        (rt) => {
          const m = id.ev(rt);
          const kk = key(rt);
          if (!m.entries.has(kk)) return naOf(v);
          touchMap(rt, m);
          const before = m.entries.get(kk) as Value;
          m.entries.delete(kk);
          return before;
        },
        call.span,
      );
    }),
    'map.size': handler(['id'], 1, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      return series('int', (rt) => id.ev(rt).entries.size, call.span);
    }),
    'map.clear': handler(['id'], 1, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          touchMap(rt, m);
          m.entries.clear();
          return null;
        },
        call.span,
      );
    }),
    'map.keys': handler(['id'], 1, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      const [k] = typeArgs(id.base) as [Base];
      c.usesObjects();
      return series(arrayOf(k), (rt) => new PineArray(k, [...id.ev(rt).entries.keys()]), call.span);
    }),
    'map.values': handler(['id'], 1, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      const [, v] = typeArgs(id.base) as [Base, Base];
      c.usesObjects();
      return series(
        arrayOf(v),
        (rt) => new PineArray(v, [...id.ev(rt).entries.values()]),
        call.span,
      );
    }),
    'map.copy': handler(['id'], 1, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      c.usesObjects();
      return series(
        id.base,
        (rt) => {
          const m = id.ev(rt);
          return new PineMap(m.key, m.value, new Map(m.entries));
        },
        call.span,
      );
    }),
    'map.put_all': handler(['id', 'id2'], 2, (c, a, call) => {
      const id = mapArg(c, a, 'id', call.span);
      const id2 = mapArg(c, a, 'id2', call.span);
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          touchMap(rt, m);
          for (const [k, v] of id2.ev(rt).entries) m.entries.set(k, v);
          return null;
        },
        call.span,
      );
    }),
  };
}

// ---- matrices ----

const at = (m: PineMatrix, r: number, c: number) => m.data[r * m.cols + c] as Value;

/** A row's or a column's index, stopping with TradingView's message (Matrices, Error handling). */
function rowIndex(raw: number, size: number, kind: 'row' | 'column', span: Span, allowEnd = false) {
  const i = Math.trunc(raw);
  const limit = allowEnd ? size : size - 1;
  if (!(i >= 0 && i <= limit)) {
    fail(`The ${kind} index (${i}) is out of bounds, ${kind} size is (${size}).`, span);
  }
  return i;
}

/** A matrix's most elements (Matrices, Error handling). */
const MAX_MATRIX = 100_000;
const matrixRoom = (elements: number, span: Span) => {
  if (elements > MAX_MATRIX) {
    fail('Matrix is too large. Maximum size of the matrix is 100,000 elements.', span);
  }
};

const matrixValues = (m: PineMatrix) => numbers(m.data);

/** Gaussian elimination with partial pivoting: the determinant, or the inverse when asked. */
function gauss(m: PineMatrix, invert: boolean): { det: number; inverse: number[] | null } {
  const n = m.rows;
  const a = (m.data as number[]).slice();
  const inv: number[] | null = invert
    ? Array.from({ length: n * n }, (_, i): number => (i % (n + 1) === 0 ? 1 : 0))
    : null;
  let det = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r * n + col] as number) > Math.abs(a[pivot * n + col] as number)) pivot = r;
    }
    const p = a[pivot * n + col] as number;
    if (Math.abs(p) < 1e-12) return { det: 0, inverse: null };
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        [a[col * n + k], a[pivot * n + k]] = [a[pivot * n + k] as number, a[col * n + k] as number];
        if (inv)
          [inv[col * n + k], inv[pivot * n + k]] = [
            inv[pivot * n + k] as number,
            inv[col * n + k] as number,
          ];
      }
      det = -det;
    }
    det *= p;
    for (let k = 0; k < n; k++) {
      a[col * n + k] = (a[col * n + k] as number) / p;
      if (inv) inv[col * n + k] = (inv[col * n + k] as number) / p;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r * n + col] as number;
      if (f === 0) continue;
      for (let k = 0; k < n; k++) {
        a[r * n + k] = (a[r * n + k] as number) - f * (a[col * n + k] as number);
        if (inv) inv[r * n + k] = (inv[r * n + k] as number) - f * (inv[col * n + k] as number);
      }
    }
  }
  return { det, inverse: inv };
}

function multiply(a: PineMatrix, b: PineMatrix): PineMatrix {
  const data: number[] = new Array(a.rows * b.cols).fill(0);
  for (let i = 0; i < a.rows; i++) {
    for (let j = 0; j < b.cols; j++) {
      let s = 0;
      for (let k = 0; k < a.cols; k++) s += (at(a, i, k) as number) * (at(b, k, j) as number);
      data[i * b.cols + j] = s;
    }
  }
  return new PineMatrix('float', a.rows, b.cols, data);
}

function transpose(m: PineMatrix): PineMatrix {
  const data: Value[] = new Array(m.rows * m.cols);
  for (let r = 0; r < m.rows; r++)
    for (let c = 0; c < m.cols; c++) data[c * m.rows + r] = at(m, r, c);
  return new PineMatrix(m.elem, m.cols, m.rows, data);
}

/** Eigenvalues and eigenvectors of a symmetric matrix (Jacobi rotations); others approximated. */
function eigen(m: PineMatrix): { values: number[]; vectors: number[] } {
  const n = m.rows;
  const a = (m.data as number[]).slice();
  const v: number[] = Array.from({ length: n * n }, (_, i): number => (i % (n + 1) === 0 ? 1 : 0));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += (a[p * n + q] as number) ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q] as number;
        if (Math.abs(apq) < 1e-15) continue;
        const theta = ((a[q * n + q] as number) - (a[p * n + p] as number)) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p] as number;
          const akq = a[k * n + q] as number;
          a[k * n + p] = cos * akp - sin * akq;
          a[k * n + q] = sin * akp + cos * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k] as number;
          const aqk = a[q * n + k] as number;
          a[p * n + k] = cos * apk - sin * aqk;
          a[q * n + k] = sin * apk + cos * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p] as number;
          const vkq = v[k * n + q] as number;
          v[k * n + p] = cos * vkp - sin * vkq;
          v[k * n + q] = sin * vkp + cos * vkq;
        }
      }
    }
  }
  const values = Array.from({ length: n }, (_, i) => a[i * n + i] as number);
  return { values, vectors: v };
}

function matrixCalls(): Record<string, Handler> {
  const m1 = (
    _fn: string,
    result: (c: Compiler, base: Base) => Base,
    f: (m: PineMatrix, rt: Runtime, span: Span) => Value,
  ) =>
    handler(['id'], 1, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const base = result(c, id.base);
      if (isReferenceType(base)) c.usesObjects();
      return series(base, (rt) => f(id.ev(rt), rt, call.span), call.span);
    });
  const numeric = (fn: string, f: (m: PineMatrix, span: Span) => Value, base: Base = 'float') =>
    m1(
      fn,
      () => base,
      (m, _rt, span) => f(m, span),
    );
  const predicate = (fn: string, f: (m: PineMatrix) => boolean) =>
    m1(
      fn,
      () => 'bool',
      (m) => f(m),
    );
  const square = (m: PineMatrix) => m.rows === m.cols;
  // TradingView's own message (Matrices, Error handling): inv, det, eigenvalues, eigenvectors.
  const needSquare = (m: PineMatrix, span: Span) => {
    if (!square(m)) fail('Operation not available for non-square matrices.', span);
  };
  const calls: Record<string, Handler> = {
    'matrix.new': (c, call, scope) => {
      const type = call.typeArgs?.[0];
      if (!type)
        return c.fail("matrix.new needs its elements' type: matrix.new<float>()", call.calleeSpan);
      const elem = c.resolveType(type, call.calleeSpan);
      c.usesObjects();
      const args = new Args(c, call, scope, ['rows', 'columns', 'initial_value'], 0);
      const rows = intArg(args, 'rows') ?? (() => 0);
      const cols = intArg(args, 'columns') ?? (() => 0);
      const init = valueArg(c, args, 'initial_value', elem) ?? (() => naOf(elem));
      return series(
        matrixOf(elem),
        (rt) => {
          const r = Math.max(0, Math.trunc(rows(rt)));
          const k = Math.max(0, Math.trunc(cols(rt)));
          matrixRoom(r * k, call.span);
          return new PineMatrix(elem, r, k, new Array(r * k).fill(init(rt)));
        },
        call.span,
      );
    },
    'matrix.copy': m1(
      'matrix.copy',
      (_c, b) => b,
      (m) => new PineMatrix(m.elem, m.rows, m.cols, m.data.slice()),
    ),
    'matrix.rows': m1(
      'matrix.rows',
      () => 'int',
      (m) => m.rows,
    ),
    'matrix.columns': m1(
      'matrix.columns',
      () => 'int',
      (m) => m.cols,
    ),
    'matrix.elements_count': m1(
      'matrix.elements_count',
      () => 'int',
      (m) => m.rows * m.cols,
    ),
    'matrix.get': handler(['id', 'row', 'column'], 3, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const row = intArg(a, 'row') as Ev<number>;
      const col = intArg(a, 'column') as Ev<number>;
      const elem = elemOf(id.base);
      return series(
        elem,
        (rt) => {
          const m = id.ev(rt);
          const r = rowIndex(row(rt), m.rows, 'row', call.span);
          const k = rowIndex(col(rt), m.cols, 'column', call.span);
          return at(m, r, k) ?? naOf(elem);
        },
        call.span,
      );
    }),
    'matrix.set': handler(['id', 'row', 'column', 'value'], 4, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const row = intArg(a, 'row') as Ev<number>;
      const col = intArg(a, 'column') as Ev<number>;
      const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          const r = rowIndex(row(rt), m.rows, 'row', call.span);
          const k = rowIndex(col(rt), m.cols, 'column', call.span);
          touchMatrix(rt, m);
          m.data[r * m.cols + k] = value(rt);
          return null;
        },
        call.span,
      );
    }),
    'matrix.row': handler(['id', 'row'], 2, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const row = intArg(a, 'row') as Ev<number>;
      const elem = elemOf(id.base);
      c.usesObjects();
      return series(
        arrayOf(elem),
        (rt) => {
          const m = id.ev(rt);
          const r = rowIndex(row(rt), m.rows, 'row', call.span);
          return new PineArray(elem, m.data.slice(r * m.cols, (r + 1) * m.cols));
        },
        call.span,
      );
    }),
    'matrix.col': handler(['id', 'column'], 2, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const col = intArg(a, 'column') as Ev<number>;
      const elem = elemOf(id.base);
      c.usesObjects();
      return series(
        arrayOf(elem),
        (rt) => {
          const m = id.ev(rt);
          const k = rowIndex(col(rt), m.cols, 'column', call.span);
          return new PineArray(
            elem,
            Array.from({ length: m.rows }, (_, r) => at(m, r, k)),
          );
        },
        call.span,
      );
    }),
    'matrix.add_row': handler(['id', 'row', 'array_id'], 1, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const row = intArg(a, 'row');
      const array = a.get('array_id');
      const arrayEv = array && isArrayType(array.base) ? array.ev : null;
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          const r = row ? rowIndex(row(rt), m.rows, 'row', call.span, true) : m.rows;
          const values = arrayEv ? ((arrayEv(rt) as PineArray | null)?.items ?? []) : [];
          const cols = m.rows === 0 && m.cols === 0 ? values.length : m.cols;
          if (values.length > 0 && values.length !== cols) {
            fail('The array size does not match the number of columns in the matrix.', call.span);
          }
          matrixRoom((m.rows + 1) * cols, call.span);
          touchMatrix(rt, m);
          m.cols = cols;
          const filled = values.length > 0 ? values : new Array(cols).fill(naOf(m.elem));
          m.data.splice(r * cols, 0, ...filled);
          m.rows++;
          return null;
        },
        call.span,
      );
    }),
    'matrix.add_col': handler(['id', 'column', 'array_id'], 1, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const col = intArg(a, 'column');
      const array = a.get('array_id');
      const arrayEv = array && isArrayType(array.base) ? array.ev : null;
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          const k = col ? rowIndex(col(rt), m.cols, 'column', call.span, true) : m.cols;
          const values = arrayEv ? ((arrayEv(rt) as PineArray | null)?.items ?? []) : [];
          const rows = m.rows === 0 && m.cols === 0 ? values.length : m.rows;
          if (values.length > 0 && values.length !== rows) {
            fail('The array size does not match the number of rows in the matrix.', call.span);
          }
          matrixRoom(rows * (m.cols + 1), call.span);
          touchMatrix(rt, m);
          const data: Value[] = [];
          for (let r = 0; r < rows; r++) {
            for (let j = 0; j <= m.cols; j++) {
              if (j === k) data.push(values.length > 0 ? (values[r] ?? null) : naOf(m.elem));
              if (j < m.cols) data.push(at(m, r, j));
            }
          }
          m.rows = rows;
          m.cols++;
          m.data = data;
          return null;
        },
        call.span,
      );
    }),
    'matrix.remove_row': handler(['id', 'row'], 1, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const row = intArg(a, 'row');
      const elem = elemOf(id.base);
      c.usesObjects();
      return series(
        arrayOf(elem),
        (rt) => {
          const m = id.ev(rt);
          const r = rowIndex(row ? row(rt) : m.rows - 1, m.rows, 'row', call.span);
          touchMatrix(rt, m);
          const removed = m.data.splice(r * m.cols, m.cols);
          m.rows--;
          return new PineArray(elem, removed);
        },
        call.span,
      );
    }),
    'matrix.remove_col': handler(['id', 'column'], 1, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const col = intArg(a, 'column');
      const elem = elemOf(id.base);
      c.usesObjects();
      return series(
        arrayOf(elem),
        (rt) => {
          const m = id.ev(rt);
          const k = rowIndex(col ? col(rt) : m.cols - 1, m.cols, 'column', call.span);
          touchMatrix(rt, m);
          const removed: Value[] = [];
          const data: Value[] = [];
          for (let r = 0; r < m.rows; r++) {
            for (let j = 0; j < m.cols; j++) (j === k ? removed : data).push(at(m, r, j));
          }
          m.cols--;
          m.data = data;
          return new PineArray(elem, removed);
        },
        call.span,
      );
    }),
    'matrix.swap_rows': handler(['id', 'row1', 'row2'], 3, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const r1 = intArg(a, 'row1') as Ev<number>;
      const r2 = intArg(a, 'row2') as Ev<number>;
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          const p = rowIndex(r1(rt), m.rows, 'row', call.span);
          const q = rowIndex(r2(rt), m.rows, 'row', call.span);
          touchMatrix(rt, m);
          for (let k = 0; k < m.cols; k++) {
            const t = m.data[p * m.cols + k] as Value;
            m.data[p * m.cols + k] = m.data[q * m.cols + k] as Value;
            m.data[q * m.cols + k] = t;
          }
          return null;
        },
        call.span,
      );
    }),
    'matrix.swap_columns': handler(['id', 'column1', 'column2'], 3, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const c1 = intArg(a, 'column1') as Ev<number>;
      const c2 = intArg(a, 'column2') as Ev<number>;
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          const p = rowIndex(c1(rt), m.cols, 'column', call.span);
          const q = rowIndex(c2(rt), m.cols, 'column', call.span);
          touchMatrix(rt, m);
          for (let r = 0; r < m.rows; r++) {
            const t = m.data[r * m.cols + p] as Value;
            m.data[r * m.cols + p] = m.data[r * m.cols + q] as Value;
            m.data[r * m.cols + q] = t;
          }
          return null;
        },
        call.span,
      );
    }),
    'matrix.fill': handler(
      ['id', 'value', 'from_row', 'to_row', 'from_column', 'to_column'],
      2,
      (c, a, call) => {
        const id = matrixArg(c, a, 'id', call.span);
        const value = valueArg(c, a, 'value', elemOf(id.base)) as Ev<Value>;
        const fr = intArg(a, 'from_row') ?? (() => 0);
        const tr = intArg(a, 'to_row');
        const fc = intArg(a, 'from_column') ?? (() => 0);
        const tc = intArg(a, 'to_column');
        return series(
          'void',
          (rt) => {
            const m = id.ev(rt);
            const v = value(rt);
            touchMatrix(rt, m);
            const rEnd = tr ? Math.min(m.rows, tr(rt)) : m.rows;
            const cEnd = tc ? Math.min(m.cols, tc(rt)) : m.cols;
            for (let r = Math.max(0, fr(rt)); r < rEnd; r++)
              for (let k = Math.max(0, fc(rt)); k < cEnd; k++) m.data[r * m.cols + k] = v;
            return null;
          },
          call.span,
        );
      },
    ),
    'matrix.submatrix': handler(
      ['id', 'from_row', 'to_row', 'from_column', 'to_column'],
      1,
      (c, a, call) => {
        const id = matrixArg(c, a, 'id', call.span);
        const fr = intArg(a, 'from_row') ?? (() => 0);
        const tr = intArg(a, 'to_row');
        const fc = intArg(a, 'from_column') ?? (() => 0);
        const tc = intArg(a, 'to_column');
        c.usesObjects();
        return series(
          id.base,
          (rt) => {
            const m = id.ev(rt);
            const r0 = Math.max(0, fr(rt));
            const r1 = tr ? Math.min(m.rows, tr(rt)) : m.rows;
            const c0 = Math.max(0, fc(rt));
            const c1 = tc ? Math.min(m.cols, tc(rt)) : m.cols;
            const data: Value[] = [];
            for (let r = r0; r < r1; r++) for (let k = c0; k < c1; k++) data.push(at(m, r, k));
            return new PineMatrix(m.elem, Math.max(0, r1 - r0), Math.max(0, c1 - c0), data);
          },
          call.span,
        );
      },
    ),
    'matrix.reshape': handler(['id', 'rows', 'columns'], 3, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const rows = intArg(a, 'rows') as Ev<number>;
      const cols = intArg(a, 'columns') as Ev<number>;
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          const r = rows(rt);
          const k = cols(rt);
          if (r * k !== m.rows * m.cols)
            fail(`A ${m.rows}x${m.cols} matrix can't become ${r}x${k}`, call.span);
          touchMatrix(rt, m);
          m.rows = r;
          m.cols = k;
          return null;
        },
        call.span,
      );
    }),
    'matrix.reverse': m1(
      'matrix.reverse',
      () => 'void',
      (m, rt) => {
        touchMatrix(rt, m);
        m.data.reverse();
        return null;
      },
    ),
    'matrix.sort': handler(['id', 'column', 'order'], 1, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const col = intArg(a, 'column') ?? (() => 0);
      const ascending = orderArg(c, a, 'order');
      return series(
        'void',
        (rt) => {
          const m = id.ev(rt);
          const k = rowIndex(col(rt), m.cols, 'column', call.span);
          const up = ascending(rt);
          const rows = Array.from({ length: m.rows }, (_, r) =>
            m.data.slice(r * m.cols, (r + 1) * m.cols),
          );
          rows.sort((p, q) => (up ? 1 : -1) * compareValues(p[k] ?? null, q[k] ?? null));
          touchMatrix(rt, m);
          m.data = rows.flat();
          return null;
        },
        call.span,
      );
    }),
    'matrix.concat': handler(['id1', 'id2'], 2, (c, a, call) => {
      const id1 = matrixArg(c, a, 'id1', call.span);
      const id2 = matrixArg(c, a, 'id2', call.span);
      return series(
        id1.base,
        (rt) => {
          const m = id1.ev(rt);
          const n = id2.ev(rt);
          if (m.cols !== n.cols) fail('Matrices joined by rows need as many columns', call.span);
          matrixRoom(m.data.length + n.data.length, call.span);
          touchMatrix(rt, m);
          m.data.push(...n.data);
          m.rows += n.rows;
          return m;
        },
        call.span,
      );
    }),
    'matrix.transpose': m1(
      'matrix.transpose',
      (_c, b) => b,
      (m) => transpose(m),
    ),
    'matrix.sum': arith('matrix.sum', (x, y) => x + y),
    'matrix.diff': arith('matrix.diff', (x, y) => x - y),
    'matrix.mult': handler(['id1', 'id2'], 2, (c, a, call) => {
      const id1 = matrixArg(c, a, 'id1', call.span);
      const other = a.get('id2') as Compiled;
      c.usesObjects();
      if (isMatrixType(other.base)) {
        const ev2 = other.ev;
        return series(
          matrixOf('float'),
          (rt) => {
            const m = id1.ev(rt);
            const n = ev2(rt) as PineMatrix;
            if (m.cols !== n.rows)
              fail(
                "The number of columns in the 'id1' matrix must equal the number of rows in the matrix (or the number of elements in the array) 'id2'.",
                call.span,
              );
            return multiply(m, n);
          },
          call.span,
        );
      }
      if (isArrayType(other.base)) {
        const ev2 = other.ev;
        return series(
          arrayOf('float'),
          (rt) => {
            const m = id1.ev(rt);
            const v = (ev2(rt) as PineArray).items as number[];
            if (m.cols !== v.length)
              fail(
                "The number of columns in the 'id1' matrix must equal the number of rows in the matrix (or the number of elements in the array) 'id2'.",
                call.span,
              );
            return new PineArray(
              'float',
              Array.from({ length: m.rows }, (_, r) =>
                v.reduce((s, x, k) => s + (at(m, r, k) as number) * x, 0),
              ),
            );
          },
          call.span,
        );
      }
      const scalar = other.ev;
      return series(
        id1.base,
        (rt) => {
          const m = id1.ev(rt);
          const s = scalar(rt) as number;
          return new PineMatrix(
            m.elem,
            m.rows,
            m.cols,
            m.data.map((x) => (x as number) * s),
          );
        },
        call.span,
      );
    }),
    'matrix.det': numeric('matrix.det', (m, span) => {
      needSquare(m, span);
      return gauss(m, false).det;
    }),
    'matrix.inv': m1(
      'matrix.inv',
      () => matrixOf('float'),
      (m, _rt, span) => {
        needSquare(m, span);
        const inverse = gauss(m, true).inverse;
        return new PineMatrix(
          'float',
          m.rows,
          m.cols,
          inverse ?? new Array(m.rows * m.cols).fill(Number.NaN),
        );
      },
    ),
    'matrix.pinv': m1(
      'matrix.pinv',
      () => matrixOf('float'),
      (m) => {
        // (AᵀA)⁻¹Aᵀ for a full-column-rank matrix (provisional for others, §11).
        const t = transpose(m);
        const ata = multiply(t, m);
        const inv = gauss(ata, true).inverse;
        if (!inv)
          return new PineMatrix(
            'float',
            m.cols,
            m.rows,
            new Array(m.rows * m.cols).fill(Number.NaN),
          );
        return multiply(new PineMatrix('float', ata.rows, ata.cols, inv), t);
      },
    ),
    'matrix.rank': numeric(
      'matrix.rank',
      (m) => {
        const a = (m.data as number[]).slice();
        let rank = 0;
        const rows = m.rows;
        const cols = m.cols;
        const rowUsed = new Array(rows).fill(false);
        for (let col = 0; col < cols; col++) {
          let pivot = -1;
          for (let r = 0; r < rows; r++)
            if (!rowUsed[r] && Math.abs(a[r * cols + col] as number) > 1e-10) {
              pivot = r;
              break;
            }
          if (pivot < 0) continue;
          rank++;
          rowUsed[pivot] = true;
          for (let r = 0; r < rows; r++) {
            if (r === pivot) continue;
            const f = (a[r * cols + col] as number) / (a[pivot * cols + col] as number);
            for (let k = col; k < cols; k++)
              a[r * cols + k] = (a[r * cols + k] as number) - f * (a[pivot * cols + k] as number);
          }
        }
        return rank;
      },
      'int',
    ),
    'matrix.trace': numeric('matrix.trace', (m) => {
      let s = 0;
      for (let i = 0; i < Math.min(m.rows, m.cols); i++) s += at(m, i, i) as number;
      return s;
    }),
    'matrix.eigenvalues': m1(
      'matrix.eigenvalues',
      () => arrayOf('float'),
      (m, _rt, span) => {
        needSquare(m, span);
        return new PineArray('float', eigen(m).values);
      },
    ),
    'matrix.eigenvectors': m1(
      'matrix.eigenvectors',
      () => matrixOf('float'),
      (m, _rt, span) => {
        needSquare(m, span);
        return new PineMatrix('float', m.rows, m.cols, eigen(m).vectors);
      },
    ),
    'matrix.kron': handler(['id1', 'id2'], 2, (c, a, call) => {
      const id1 = matrixArg(c, a, 'id1', call.span);
      const id2 = matrixArg(c, a, 'id2', call.span);
      c.usesObjects();
      return series(
        matrixOf('float'),
        (rt) => {
          const m = id1.ev(rt);
          const n = id2.ev(rt);
          const rows = m.rows * n.rows;
          const cols = m.cols * n.cols;
          const data: number[] = new Array(rows * cols);
          for (let i = 0; i < m.rows; i++)
            for (let j = 0; j < m.cols; j++)
              for (let k = 0; k < n.rows; k++)
                for (let l = 0; l < n.cols; l++)
                  data[(i * n.rows + k) * cols + j * n.cols + l] =
                    (at(m, i, j) as number) * (at(n, k, l) as number);
          return new PineMatrix('float', rows, cols, data);
        },
        call.span,
      );
    }),
    'matrix.pow': handler(['id', 'power'], 2, (c, a, call) => {
      const id = matrixArg(c, a, 'id', call.span);
      const power = intArg(a, 'power') as Ev<number>;
      c.usesObjects();
      return series(
        matrixOf('float'),
        (rt) => {
          const m = id.ev(rt);
          needSquare(m, call.span);
          let result = new PineMatrix(
            'float',
            m.rows,
            m.cols,
            Array.from({ length: m.rows * m.cols }, (_, i) => (i % (m.rows + 1) === 0 ? 1 : 0)),
          );
          for (let i = 0; i < power(rt); i++) result = multiply(result, m);
          return result;
        },
        call.span,
      );
    }),
    'matrix.is_square': predicate('matrix.is_square', square),
    'matrix.is_identity': predicate(
      'matrix.is_identity',
      (m) => square(m) && m.data.every((x, i) => x === (i % (m.cols + 1) === 0 ? 1 : 0)),
    ),
    'matrix.is_binary': predicate('matrix.is_binary', (m) =>
      m.data.every((x) => x === 0 || x === 1),
    ),
    'matrix.is_zero': predicate('matrix.is_zero', (m) => m.data.every((x) => x === 0)),
    'matrix.is_symmetric': predicate('matrix.is_symmetric', (m) => {
      if (!square(m)) return false;
      for (let r = 0; r < m.rows; r++)
        for (let k = 0; k < r; k++) if (at(m, r, k) !== at(m, k, r)) return false;
      return true;
    }),
    'matrix.is_antisymmetric': predicate('matrix.is_antisymmetric', (m) => {
      if (!square(m)) return false;
      for (let r = 0; r < m.rows; r++)
        for (let k = 0; k <= r; k++)
          if ((at(m, r, k) as number) !== -(at(m, k, r) as number)) return false;
      return true;
    }),
    'matrix.is_diagonal': predicate(
      'matrix.is_diagonal',
      (m) => square(m) && m.data.every((x, i) => i % (m.cols + 1) === 0 || x === 0),
    ),
    'matrix.is_antidiagonal': predicate('matrix.is_antidiagonal', (m) => {
      if (!square(m)) return false;
      for (let r = 0; r < m.rows; r++)
        for (let k = 0; k < m.cols; k++)
          if (r + k !== m.cols - 1 && at(m, r, k) !== 0) return false;
      return true;
    }),
    'matrix.is_triangular': predicate('matrix.is_triangular', (m) => {
      if (!square(m)) return false;
      let upper = true;
      let lower = true;
      for (let r = 0; r < m.rows; r++)
        for (let k = 0; k < m.cols; k++) {
          if (k < r && at(m, r, k) !== 0) upper = false;
          if (k > r && at(m, r, k) !== 0) lower = false;
        }
      return upper || lower;
    }),
    'matrix.is_stochastic': predicate('matrix.is_stochastic', (m) => {
      for (let r = 0; r < m.rows; r++) {
        let s = 0;
        for (let k = 0; k < m.cols; k++) {
          const x = at(m, r, k) as number;
          if (x < 0) return false;
          s += x;
        }
        if (Math.abs(s - 1) > 1e-9) return false;
      }
      return true;
    }),
    'matrix.max': numeric('matrix.max', (m) => {
      const xs = matrixValues(m);
      return xs.length ? Math.max(...xs) : Number.NaN;
    }),
    'matrix.min': numeric('matrix.min', (m) => {
      const xs = matrixValues(m);
      return xs.length ? Math.min(...xs) : Number.NaN;
    }),
    'matrix.avg': numeric('matrix.avg', (m) => mean(matrixValues(m))),
    'matrix.median': numeric('matrix.median', (m) => median(matrixValues(m))),
    'matrix.mode': numeric('matrix.mode', (m) => modeOf(matrixValues(m))),
  };
  return calls;
}

/** matrix.sum and matrix.diff: with another matrix of the same size, or with a number. */
function arith(fn: string, f: (x: number, y: number) => number): Handler {
  return handler(['id1', 'id2'], 2, (c, a, call) => {
    const id1 = matrixArg(c, a, 'id1', call.span);
    const other = a.get('id2') as Compiled;
    const ev2 = other.ev;
    const isMatrix = isMatrixType(other.base);
    c.usesObjects();
    return series(
      id1.base,
      (rt) => {
        const m = id1.ev(rt);
        const y = ev2(rt);
        if (isMatrix) {
          const n = y as PineMatrix;
          if (n.rows !== m.rows || n.cols !== m.cols)
            fail(
              fn === 'matrix.sum'
                ? "Matrices 'id1' and 'id2' must have an equal number of rows and columns to be added."
                : `Matrices 'id1' and 'id2' must have an equal number of rows and columns ('${fn}')`,
              call.span,
            );
          return new PineMatrix(
            m.elem,
            m.rows,
            m.cols,
            m.data.map((x, i) => f(x as number, n.data[i] as number)),
          );
        }
        return new PineMatrix(
          m.elem,
          m.rows,
          m.cols,
          m.data.map((x) => f(x as number, y as number)),
        );
      },
      call.span,
    );
  });
}

/** Every array.*, map.* and matrix.* function, by name. */
export function collectionCalls(): Record<string, Handler> {
  return { ...arrayCalls(), ...mapCalls(), ...matrixCalls() };
}
