import { describe, expect, it } from 'vitest';
import { ScriptRun } from './script.ts';
import {
  closes,
  compileError,
  forming,
  indicator,
  program,
  runScript,
  series,
  walk,
} from './testing.ts';

/**
 * Pine's types beyond numbers (Pine docs: Objects, Methods, Enums, Arrays, Maps, Matrices,
 * Loops): what TradingView's manual says each does, on our own small scripts.
 */

const bars = closes([10, 12, 11, 15, 14, 13, 18, 17, 16, 20]);

describe('user-defined types and objects', () => {
  it('makes objects with fields by position or name, the rest their defaults', () => {
    expect(
      series(
        `type Point
    float x = 1.0
    float y
p = Point.new(y = 2.0)
q = Point.new(5.0, 7.0)
plot(p.x + p.y + q.x * q.y)`,
        bars,
      )[0],
    ).toBe(1 + 2 + 35);
  });

  it('assigns fields, keeps a var object from bar to bar, and copies objects apart', () => {
    expect(
      series(
        `type Counter
    int n = 0
var c = Counter.new()
c.n += 1
d = c.copy()
d.n := 100
plot(c.n)`,
        bars,
      ).slice(0, 4),
    ).toEqual([1, 2, 3, 4]);
  });

  it('calls methods declared for a type with dot syntax, and functions taking objects', () => {
    expect(
      series(
        `type Box
    float lo
    float hi
method width(Box self) => self.hi - self.lo
grow(Box b, float amount) =>
    b.hi += amount
    b
b = Box.new(low, high)
plot(grow(b, 1).width())`,
        bars,
      )[0],
    ).toBe(10.5 - 9.5 + 1);
  });

  it('reads an object’s history, then its field', () => {
    const values = series(
      `type P
    float v
p = P.new(close)
plot(bar_index > 0 ? (p[1]).v : na)`,
      bars,
    );
    expect(values.slice(0, 3)).toEqual([Number.NaN, 10, 12]);
  });

  it('stops with a runtime error when a field is read on an na object', () => {
    const run = runScript(
      indicator(`type P
    float v
P p = na
plot(p.v)`),
      bars,
    );
    expect(run.error?.message).toMatch(/object that is na/);
  });

  it('refuses a field the type doesn’t have, and an unknown type', () => {
    expect(
      compileError(
        indicator(`type P
    float v
p = P.new(1)
plot(p.w)`),
      ).message,
    ).toMatch(/"P" has no field "w"/);
    expect(compileError(indicator('Missing m = na\nplot(close)')).message).toMatch(
      /Unknown type "Missing"/,
    );
  });
});

describe('enums', () => {
  it('names members, compares them and switches on them', () => {
    expect(
      series(
        `enum Dir
    up = "Up"
    down = "Down"
d = close > open ? Dir.up : Dir.down
v = switch d
    Dir.up => 1
    Dir.down => -1
plot(v)`,
        bars,
      ).slice(1, 4),
    ).toEqual([1, -1, 1]);
  });
});

describe('arrays (Pine docs, Arrays)', () => {
  it('pushes, reads and counts, with methods or functions alike', () => {
    expect(
      series(
        `var a = array.new_float()
a.push(close)
array.push(a, close * 2)
plot(a.size() + array.get(a, 0) + a.last())`,
        bars,
      )[0],
    ).toBe(2 + 10 + 20);
  });

  it('types array.from() by its values, and takes generic and [] declarations', () => {
    expect(
      series(
        `array<float> a = array.from(1, 2.5, 3)
float[] b = array.new<float>(2, 4.0)
int[] c = array.from(1, 2)
plot(a.sum() + b.sum() + c.sum())`,
        bars,
      )[0],
    ).toBe(6.5 + 8 + 3);
  });

  it('counts negative indices from the end in v6; v5 stops with an error', () => {
    expect(series('a = array.from(1, 2, 3)\nplot(a.get(-1))', bars)[0]).toBe(3);
    const run = runScript(
      `//@version=5
indicator("Test")
a = array.from(1, 2, 3)
plot(a.get(-1))`,
      bars,
    );
    expect(run.error?.message).toMatch(/Index -1 is out of bounds\. Array size is 3/);
  });

  it('stops with TradingView’s own messages (Arrays, Error handling)', () => {
    const error = (body: string) =>
      runScript(indicator(`${body}\nplot(close)`), bars).error?.message;
    expect(error('a = array.new<float>(0)\na.pop()')).toBe('Cannot use pop() if array is empty.');
    expect(error('a = array.new<float>(0)\na.shift()')).toBe(
      'Cannot use shift() if array is empty.',
    );
    expect(error('a = array.new<float>(-1)')).toBe('Cannot create an array with a negative size');
    expect(error('a = array.new<float>(100001)')).toBe(
      'Array is too large. Maximum size is 100000',
    );
    expect(error('a = array.new<float>(100000)\na.push(1)')).toBe(
      'Array is too large. Maximum size is 100000',
    );
    expect(error('array<int> a = na\narray.push(a, 111)')).toBe(
      "Cannot call array methods when ID of array is 'na'",
    );
  });

  it('reads na at an na index, as the manual’s “Distance from high” needs; writing there stops', () => {
    // ta.highestbars is na until its length's bar, and TradingView still runs the example.
    expect(series('a = array.from(1, 2, 3)\nplot(a.get(int(na)))', bars)[0]).toBeNaN();
    const run = runScript(
      indicator('a = array.from(1, 2, 3)\na.set(int(na), 4)\nplot(a.get(0))'),
      bars,
    );
    expect(run.error?.message).toMatch(/The index of 'array.set' is na/);
  });

  it('works out statistics, sorts and joins', () => {
    expect(
      series(
        `a = array.from(3.0, 1.0, 4.0, 1.0, 5.0)
s = a.copy()
s.sort()
plot(a.avg() * 1000 + a.median() * 100 + a.mode() * 10 + s.get(4))`,
        bars,
      )[0],
    ).toBeCloseTo(2.8 * 1000 + 3 * 100 + 1 * 10 + 5, 9);
    const p = program(
      indicator(`a = array.from(1, 2, 3)
s = a.join(", ")
plot(s == "1, 2, 3" ? 1 : 0)`),
    );
    const run = new ScriptRun(p, []);
    run.setBars(bars, true);
    expect(run.values[0]?.[0]).toBe(1);
  });

  it('loops through an array with for…in, the index too when asked, and breaks', () => {
    expect(
      series(
        `a = array.from(5, 6, 7, 8)
total = 0
for [i, x] in a
    if i == 3
        break
    total += i * x
for x in a
    total += x
plot(total)`,
        bars,
      )[0],
    ).toBe(0 * 5 + 1 * 6 + 2 * 7 + 26);
  });

  it('rolls back the live bar’s changes to a var array on its next update', () => {
    const p = program(
      indicator(`var a = array.new_float()
a.push(close)
plot(a.size())`),
    );
    const run = new ScriptRun(p, []);
    const history = walk(20);
    run.setBars(history, true);
    expect(run.values[0]?.[19]).toBe(20);
    // Three updates of the live bar: each runs from the last commit, so the size stays 20.
    let live = history;
    for (let tick = 1; tick <= 3; tick++) {
      live = [...history.slice(0, -1), forming(history[19] as (typeof history)[number], tick)];
      run.update(live, 'tick', 19);
      expect(run.values[0]?.[19]).toBe(20);
    }
  });
});

describe('maps and matrices (Pine docs, Maps and Matrices)', () => {
  it('puts, gets and lists keys in the order they were first put', () => {
    expect(
      series(
        `m = map.new<string, float>()
m.put("b", 2)
m.put("a", 1)
m.put("b", 3)
k = m.keys()
plot(m.get("b") * 100 + m.size() * 10 + (k.get(0) == "b" ? 1 : 0))`,
        bars,
      )[0],
    ).toBe(300 + 20 + 1);
  });

  it('loops through a map with for [key, value] in', () => {
    expect(
      series(
        `m = map.new<int, int>()
m.put(1, 10)
m.put(2, 20)
t = 0
for [k, v] in m
    t += k * v
plot(t)`,
        bars,
      )[0],
    ).toBe(10 + 40);
  });

  it('multiplies, inverts and finds a matrix’s determinant', () => {
    expect(
      series(
        `m = matrix.new<float>(2, 2, 0)
m.set(0, 0, 4)
m.set(0, 1, 7)
m.set(1, 0, 2)
m.set(1, 1, 6)
i = m.inv()
p = m.mult(i)
plot(m.det() * 100 + p.get(0, 0) + p.get(1, 1))`,
        bars,
      )[0],
    ).toBeCloseTo(10 * 100 + 2, 9);
  });

  it('stops with TradingView’s own messages (Matrices, Error handling)', () => {
    const error = (body: string) =>
      runScript(indicator(`${body}\nplot(close)`), bars).error?.message;
    // The manual's "Non-square demo" and "Matrix too large demo".
    expect(error('m = matrix.new<float>(3, 5, 1)\nx = m.det()')).toBe(
      'Operation not available for non-square matrices.',
    );
    expect(error('m = matrix.new<float>(1000, 101)')).toBe(
      'Matrix is too large. Maximum size of the matrix is 100,000 elements.',
    );
    expect(error('m = matrix.new<float>(2, 2)\nm.set(2, 0, 1)')).toBe(
      'The row index (2) is out of bounds, row size is (2).',
    );
    expect(error('m = matrix.new<float>(2, 3, 1)\nx = matrix.mult(m, m)')).toBe(
      "The number of columns in the 'id1' matrix must equal the number of rows in the matrix (or the number of elements in the array) 'id2'.",
    );
    expect(error('matrix<float> m = na\nx = m.rows()')).toBe(
      "Cannot call matrix methods when the ID of matrix is 'na'.",
    );
  });
});
