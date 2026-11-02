import { describe, expect, it } from 'vitest';
import { applyEdits, convertToV6 } from './convert.ts';
import { closes, firstDifference, plots } from './testing.ts';

const bars = closes([10, 11, 12, 11, 13, 14, 12, 15, 16, 14]);
const v5 = (body: string) => `//@version=5\nindicator("Test")\n${body}`;

/** The converted code, which must convert. */
function converted(source: string): string {
  const result = convertToV6(source);
  if (!result.ok) throw new Error(`Didn't convert: ${result.reason}`);
  expect(result.errors).toEqual([]);
  return result.source;
}

describe('Convert code to v6 (the v6 migration guide, Converting v5 to v6)', () => {
  it('writes the guide’s own fixes, and the script gives the same values', () => {
    const source = v5(`a = bar_index % 3
x = a ? close : open
y = 5 / 2
z = 10[1]
plot(x, "Close or open", title = "Twice")
plot(y + z, color = color.red, transp = 80)`);
    const code = converted(source);
    expect(code).toBe(`//@version=6
indicator("Test")
a = bar_index % 3
x = bool(a) ? close : open
y = int(5 / 2)
z = 10
plot(x, "Close or open")
plot(y + z, color = color.new(color.red, 80))`);
    expect(firstDifference(plots(source, bars)[0] ?? [], plots(code, bars)[0] ?? [])).toBe(-1);
  });

  it('converts only v5 code, and only code that compiles', () => {
    expect(convertToV6('//@version=6\nindicator("x")\nplot(close)')).toMatchObject({
      ok: false,
      reason: 'not-v5',
    });
    expect(convertToV6(v5('plot(nope)'))).toMatchObject({ ok: false, reason: 'does-not-compile' });
  });

  it('shows the errors a converted script still has, as the guide says can happen', () => {
    // A switch giving a plot style needs its default block in v6 (the guide's own example).
    const result = convertToV6(
      v5(`s = input.string("Area", options = ["Area", "Columns"])
style = switch s
    "Area" => plot.style_area
    "Columns" => plot.style_columns
plot(close, style = style)`),
    );
    expect(result.ok && result.errors[0]?.message).toMatch(/must have a default block/);
  });

  it('nests changes in one another, and drops those inside a removed part', () => {
    // The compiler finds int() on a division before bool() on its result, so on one span the
    // later change goes outside.
    const code = 'x = f(a / b, c, c = d / e)';
    const span = (column: number, endColumn: number) => ({
      line: 1,
      column,
      endLine: 1,
      endColumn,
    });
    expect(
      applyEdits(code, [
        { span: span(7, 12), before: 'int(', after: ')' },
        { span: span(7, 12), before: 'bool(', after: ')' },
        { span: span(15, 26), replace: '' },
        { span: span(21, 26), before: 'int(', after: ')' },
      ]),
    ).toBe('x = f(bool(int(a / b)), c)');
  });
});
