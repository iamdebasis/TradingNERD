import { describe, expect, it } from 'vitest';
import { closes, compileError, indicator, runScript } from './testing.ts';
import { COLORS } from './values.ts';

/**
 * Pine's drawings: labels, lines, boxes, tables, polylines and linefills (Pine docs: Text and
 * shapes, Lines and boxes, Tables, Polylines; Limitations; the v6 reference). Defaults the
 * reference's text leaves out are marked provisional (docs/SPEC.md §11).
 */

const bars = (n: number) => closes(Array.from({ length: n }, (_, i) => 100 + (i % 7)));

describe('labels', () => {
  it('draws one per call, with its text, place and the reference’s defaults', () => {
    const run = runScript(
      indicator('if bar_index == 2\n    label.new(bar_index, high, "Hi", textcolor = color.white)'),
      bars(5),
    );
    expect(run.error).toBeNull();
    const [label] = run.drawings.labels;
    expect(run.drawings.labels).toHaveLength(1);
    expect(label).toMatchObject({
      x: 2,
      text: 'Hi',
      xloc: 'bar_index',
      yloc: 'price',
      style: 'label_down',
      size: 'normal',
      color: COLORS.blue,
      textcolor: COLORS.white,
    });
  });

  it('keeps the last 50 by default, and max_labels_count of them up to 500', () => {
    // "the last 50 drawings … by default"; "max_labels_count … up to 500" (Limitations).
    const each = 'label.new(bar_index, close, str.tostring(bar_index))';
    const plain = runScript(indicator(each), bars(80));
    expect(plain.drawings.labels).toHaveLength(50);
    expect(plain.drawings.labels[0]?.text).toBe('30');
    expect(plain.drawings.labels.at(-1)?.text).toBe('79');
    const more = runScript(indicator(each, 'indicator("T", max_labels_count = 70)'), bars(80));
    expect(more.drawings.labels).toHaveLength(70);
    const most = runScript(indicator(each, 'indicator("T", max_labels_count = 900)'), bars(600));
    expect(most.drawings.labels).toHaveLength(500);
  });

  it('changes a var label in place, and reads back what it set', () => {
    const run = runScript(
      indicator(`var label l = label.new(na, na, "")
label.set_xy(l, bar_index, close)
label.set_text(l, "Bar " + str.tostring(bar_index))
l.set_color(color.red)
plot(label.get_x(l))`),
      bars(6),
    );
    expect(run.drawings.labels).toHaveLength(1);
    expect(run.drawings.labels[0]).toMatchObject({ x: 5, text: 'Bar 5', color: COLORS.red });
    expect(Array.from(run.values[0] ?? []).slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('deletes one, and label.all lists what is left', () => {
    const run = runScript(
      indicator(`l = label.new(bar_index, close, "x")
if bar_index % 2 == 0
    label.delete(l)
plot(label.all.size())`),
      bars(6),
    );
    expect(run.drawings.labels.map((l) => l.x)).toEqual([1, 3, 5]);
    expect(Array.from(run.values[0] ?? []).at(5)).toBe(3);
  });

  it('rolls back what the live bar drew on each update, as TradingView does', () => {
    const series = bars(10);
    const run = runScript(indicator('label.new(bar_index, close, str.tostring(close))'), series);
    expect(run.drawings.labels).toHaveLength(10);
    const ticked = series.map((bar, i) => (i === 9 ? { ...bar, close: 555 } : bar));
    run.update(ticked, 'tick', 9);
    // Still one label for the live bar: the update's, not both.
    expect(run.drawings.labels).toHaveLength(10);
    expect(run.drawings.labels.at(-1)?.text).toBe('555');
  });

  it('takes chart.point for its place: its index, or its time with xloc.bar_time', () => {
    // "xloc … Default is xloc.bar_index": a point made from a time alone has no index then.
    const run = runScript(
      indicator(`if barstate.islast
    label.new(chart.point.from_index(bar_index - 1, 42), "a")
    label.new(chart.point.from_time(time, 43), "b", xloc = xloc.bar_time)
    label.new(chart.point.from_time(time, 44), "c")`),
      bars(4),
    );
    const [a, b, c] = run.drawings.labels;
    expect(a).toMatchObject({ x: 2, y: 42, xloc: 'bar_index' });
    // Pine's time is in milliseconds; the bars' in seconds.
    expect(b).toMatchObject({ x: (bars(4)[3]?.time ?? 0) * 1000, y: 43, xloc: 'bar_time' });
    expect(c?.x).toBeNaN();
  });
});

describe('lines and boxes', () => {
  it('draws a line between two points, extended as asked, and gives its price at a bar', () => {
    const run = runScript(
      indicator(`var line l = line.new(0, 100, 4, 104, extend = extend.right, style = line.style_dashed)
plot(line.get_price(l, 8))`),
      bars(5),
    );
    expect(run.drawings.lines[0]).toMatchObject({
      x1: 0,
      y1: 100,
      x2: 4,
      y2: 104,
      extend: 'right',
      style: 'dashed',
      width: 1,
      color: COLORS.blue,
    });
    expect(Array.from(run.values[0] ?? []).at(4)).toBe(108);
  });

  it('draws a box with its text, and moves its corners', () => {
    const run = runScript(
      indicator(`var box b = box.new(0, 110, 2, 90, text = "Range", bgcolor = color.new(color.teal, 80))
box.set_right(b, bar_index)
box.set_top(b, math.max(box.get_top(b), high))`),
      bars(5),
    );
    expect(run.drawings.boxes).toHaveLength(1);
    expect(run.drawings.boxes[0]).toMatchObject({ left: 0, right: 4, bottom: 90, text: 'Range' });
  });

  it('fills between two lines, and the fill goes with either line', () => {
    const run = runScript(
      indicator(`a = line.new(bar_index, high, bar_index + 1, high)
b = line.new(bar_index, low, bar_index + 1, low)
linefill.new(a, b, color.new(color.green, 70))
if bar_index % 2 == 1
    line.delete(a)`),
      bars(4),
    );
    expect(run.drawings.linefills).toHaveLength(2);
    expect(run.drawings.lines).toHaveLength(6);
  });
});

describe('tables', () => {
  it('fills its cells, merges them, and clears them', () => {
    const run = runScript(
      indicator(`var table t = table.new(position.top_right, 2, 2, border_width = 1)
if barstate.islast
    table.cell(t, 0, 0, "A", text_color = color.white, bgcolor = color.navy)
    table.cell(t, 1, 0, "B")
    table.cell(t, 0, 1, "C")
    table.merge_cells(t, 0, 1, 1, 1)
    table.cell_set_text(t, 1, 0, "B2")`),
      bars(3),
    );
    const [t] = run.drawings.tables;
    expect(t).toMatchObject({ position: 'top_right', columns: 2, rows: 2, borderWidth: 1 });
    expect(t?.cells[0]?.[0]).toMatchObject({ text: 'A', textColor: COLORS.white });
    expect(t?.cells[0]?.[1]?.text).toBe('B2');
    expect(t?.merges).toEqual([{ c0: 0, r0: 1, c1: 1, r1: 1 }]);
  });

  it('stops with a runtime error on a cell outside the table', () => {
    const run = runScript(
      indicator('var table t = table.new(position.top_right, 1, 1)\ntable.cell(t, 3, 0, "x")'),
      bars(2),
    );
    expect(run.error?.message).toMatch(/column|out of|range|bounds/i);
  });
});

describe('polylines', () => {
  it('draws through an array of chart points, copied when it was made', () => {
    const run = runScript(
      indicator(`var points = array.new<chart.point>()
points.push(chart.point.from_index(bar_index, close))
if barstate.islast
    polyline.new(points, curved = true, line_color = color.orange)`),
      bars(5),
    );
    const [p] = run.drawings.polylines;
    expect(p?.points.map((pt) => pt.x)).toEqual([0, 1, 2, 3, 4]);
    expect(p).toMatchObject({ curved: true, closed: false, lineColor: COLORS.orange });
  });
});

describe('drawing types', () => {
  it('counts as a script output, so a script that only draws is accepted', () => {
    const run = runScript(indicator('label.new(bar_index, close, "x")'), bars(2));
    expect(run.error).toBeNull();
  });

  it('keeps a const reference to a drawing, its id a series value (the manual, Type system)', () => {
    // "a script can declare a const variable that maintains a constant reference to an
    // expression returning the ID of a special type".
    const run = runScript(indicator('const label myVar = label.new(bar_index, close)'), bars(3));
    expect(run.error).toBeNull();
    expect(run.drawings.labels).toHaveLength(3);
    expect(compileError(indicator('const float c = close\nplot(c)')).message).toMatch(/const/);
    expect(
      compileError(indicator('const label l = label.new(0, 0)\nl := label.new(1, 1)\nplot(close)'))
        .message,
    ).toMatch(/const/);
  });

  it('refuses a drawing where its id type is expected, by name', () => {
    expect(compileError(indicator('label l = line.new(0, 0, 1, 1)\nplot(close)')).message).toMatch(
      /line|label/,
    );
  });
});
