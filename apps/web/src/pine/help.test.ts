import { describe, expect, it } from 'vitest';
import {
  callAt,
  colorsIn,
  colorText,
  completionContext,
  declaredNames,
  describe as describeEntry,
  nameAt,
  suggestions,
} from './help';

describe('Suggestions as you type', () => {
  it('suggest a namespace’s members after its dot, the engine’s own', () => {
    const context = completionContext('plot(ta.s');
    expect(context).toEqual({ namespace: 'ta', prefix: 's' });
    const labels = suggestions(context, '').map((item) => item.label);
    expect(labels).toContain('sma');
    expect(labels).toContain('stoch');
    expect(labels.every((label) => !label.includes('.'))).toBe(true);
  });

  it('suggest top-level names, keywords and what the script declares', () => {
    const text =
      '//@version=6\nindicator("x")\nlength = input.int(14)\nvar float level = 0\nf(x) => x\n';
    expect(declaredNames(text)).toEqual(['length', 'level', 'f']);
    const labels = suggestions(completionContext('le'), text).map((item) => item.label);
    expect(labels).toEqual(
      expect.arrayContaining(['ta', 'close', 'plot', 'if', 'length', 'level']),
    );
  });
});

describe('A function’s parameters inside its parentheses', () => {
  it('finds the call and the argument at the cursor', () => {
    expect(callAt('x = ta.sma(close, ')).toEqual({ callee: 'ta.sma', argument: 1, named: null });
    expect(callAt('plot(ta.sma(close, 14), color = ')).toEqual({
      callee: 'plot',
      argument: 1,
      named: 'color',
    });
    // Commas inside strings and nested calls don't count.
    expect(callAt('label("a, b", math.max(1, 2), ')).toEqual({
      callee: 'label',
      argument: 2,
      named: null,
    });
    expect(callAt('plot(close)')).toBeNull();
  });

  it('describes a function by its parameters as the engine reads them', () => {
    expect(describeEntry({ name: 'ta.sma', kind: 'function' })).toBe('ta.sma(source, length)');
  });
});

describe('Hover', () => {
  it('reads the dotted name under the cursor, up to the hovered part', () => {
    const line = 'x = ta.sma(close, 14)';
    expect(nameAt(line, 9)?.name).toBe('ta.sma');
    expect(nameAt(line, 5)?.name).toBe('ta');
    expect(nameAt(line, 13)?.name).toBe('close');
  });
});

describe('Color swatches', () => {
  it('find every way the code writes a color', () => {
    const text =
      'a = color.red\nb = #FF000080\nc = color.new(color.blue, 50)\nd = color.rgb(1, 2, 3, 20)';
    const colors = colorsIn(text).map(({ form, red, green, blue, alpha }) => ({
      form,
      rgba: [red, green, blue, Math.round(alpha * 100) / 100],
    }));
    expect(colors).toEqual([
      { form: 'constant', rgba: [0xf2, 0x36, 0x45, 1] },
      { form: 'hex', rgba: [255, 0, 0, 0.5] },
      { form: 'new', rgba: [0x29, 0x62, 0xff, 0.5] },
      { form: 'rgb', rgba: [1, 2, 3, 0.8] },
    ]);
  });

  it('write a picked color back in the form it was written', () => {
    const color = { red: 255, green: 0, blue: 0, alpha: 1 };
    expect(colorText({ ...color, form: 'constant' })).toBe('#FF0000');
    expect(colorText({ ...color, alpha: 0.5, form: 'hex' })).toBe('#FF000080');
    expect(colorText({ ...color, alpha: 0.5, form: 'new' })).toBe('color.rgb(255, 0, 0, 50)');
    expect(colorText({ ...color, form: 'rgb' })).toBe('color.rgb(255, 0, 0)');
  });
});
