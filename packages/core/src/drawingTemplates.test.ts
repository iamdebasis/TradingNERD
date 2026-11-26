import { describe, expect, it } from 'vitest';
import {
  type DrawingLevel,
  defaultDrawingStyle,
  newDrawing,
  PITCHFORK_LEVELS,
} from './drawings.ts';
import {
  applyDrawingStyle,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATES_PER_TOOL,
  parseDrawingTemplatesFile,
  parseToolTemplates,
  sameStyle,
  sortedTemplates,
  styleWithoutText,
  templateName,
} from './drawingTemplates.ts';

/** A trend line with some text, locked, under the bars, shown on hours only. */
const line = () => {
  const drawing = newDrawing('a', 'trend-line', [
    { time: 1, price: 1 },
    { time: 2, price: 2 },
  ]);
  drawing.style.text.value = 'Breakout';
  drawing.locked = true;
  drawing.below = true;
  drawing.visibility.minutes.on = false;
  return drawing;
};

/** A red, 4 px, dashed trend line style. */
const red = () => {
  const style = defaultDrawingStyle('trend-line');
  style.color = '#F23645';
  style.width = 4;
  style.lineStyle = 'dashed';
  return style;
};

describe('drawing templates (D3b)', () => {
  it('keeps a name trimmed, each run of spaces one', () => {
    expect(templateName('  Red   line \t 2 ')).toBe('Red line 2');
    expect(templateName('   ')).toBe('');
  });

  it('keeps a drawing’s style without its text, sharing nothing with it', () => {
    const drawing = line();
    const kept = styleWithoutText(drawing.style);
    expect(kept.text.value).toBe('');
    expect({ ...kept, text: { ...kept.text, value: 'Breakout' } }).toEqual(drawing.style);
    kept.stats.angle = true;
    expect(drawing.style.stats.angle).toBe(false);
  });

  it('applies a style, keeping the drawing’s text, points, visibility, lock and place', () => {
    const drawing = line();
    const styled = applyDrawingStyle(drawing, red());
    expect(styled.style).toEqual({ ...red(), text: { ...red().text, value: 'Breakout' } });
    expect(styled).toEqual({ ...drawing, style: styled.style });
    // The same drawing back when nothing changes, so no undo step is made of it.
    expect(applyDrawingStyle(styled, red())).toBe(styled);
  });

  it('tells two styles the same whatever their text and their keys’ order', () => {
    const a = red();
    const b = JSON.parse(JSON.stringify({ ...a, text: { ...a.text, value: 'x' } }));
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    expect(sameStyle(a, reordered as unknown as typeof a)).toBe(true);
    expect(sameStyle(a, { ...a, width: 3 })).toBe(false);
    expect(sameStyle(a, { ...a, levels: [{ ...(PITCHFORK_LEVELS[0] as DrawingLevel) }] })).toBe(
      false,
    );
  });

  it('lists a tool’s templates by name, case and numbers aside', () => {
    const style = red();
    const names = ['red 10', 'Blue', 'Red 2', 'alpha'];
    expect(
      sortedTemplates(names.map((name) => ({ name, style }))).map((item) => item.name),
    ).toEqual(['alpha', 'Blue', 'Red 2', 'red 10']);
  });

  it('reads a tool’s templates, each style over its tool’s defaults and without text', () => {
    const parsed = parseToolTemplates({
      tool: 'pitchfork',
      templates: [
        // An older style without D2's fields takes the tool's defaults for them.
        { name: '  Wide  ', style: { color: '#ffb74d', width: 3, text: { value: 'kept?' } } },
      ],
    });
    expect(parsed?.tool).toBe('pitchfork');
    expect(parsed?.templates[0]?.name).toBe('Wide');
    const style = parsed?.templates[0]?.style;
    expect(style?.color).toBe('#FFB74D');
    expect(style?.width).toBe(3);
    expect(style?.text.value).toBe('');
    expect(style?.levels).toEqual(defaultDrawingStyle('pitchfork').levels);
  });

  it('refuses templates that aren’t valid', () => {
    const style = red();
    const of = (templates: unknown, tool: unknown = 'trend-line') =>
      parseToolTemplates({ tool, templates });
    expect(of([{ name: 'Red', style }])).not.toBeNull();
    expect(of([{ name: 'Red', style }], 'brush')).toBeNull();
    expect(of({ name: 'Red', style })).toBeNull();
    expect(of([{ name: '   ', style }])).toBeNull();
    expect(of([{ name: 'x'.repeat(MAX_TEMPLATE_NAME + 1), style }])).toBeNull();
    expect(of([{ name: 'x'.repeat(MAX_TEMPLATE_NAME), style }])).not.toBeNull();
    // A line break or a tab is a space; other control characters aren't taken.
    expect(of([{ name: 'Two\nlines', style }])?.templates[0]?.name).toBe('Two lines');
    expect(of([{ name: 'Bell\u0007', style }])).toBeNull();
    expect(of([{ name: 'Red' }])).toBeNull();
    expect(of([{ name: 7, style }])).toBeNull();
    // Each name once, after trimming.
    expect(
      of([
        { name: 'Red', style },
        { name: ' Red ', style },
      ]),
    ).toBeNull();
    const many = Array.from({ length: MAX_TEMPLATES_PER_TOOL + 1 }, (_, i) => ({
      name: `T${i}`,
      style,
    }));
    expect(of(many)).toBeNull();
    expect(of(many.slice(1))).not.toBeNull();
  });

  it('reads the file: version 1, a tool without templates left out', () => {
    const style = styleWithoutText(red());
    const file = {
      version: 1,
      tools: { 'trend-line': [{ name: 'Red', style }], ray: [] },
    };
    expect(parseDrawingTemplatesFile(file)).toEqual({
      version: 1,
      tools: { 'trend-line': [{ name: 'Red', style }] },
    });
    expect(parseDrawingTemplatesFile({ ...file, version: 2 })).toBeNull();
    expect(parseDrawingTemplatesFile({ version: 1 })).toBeNull();
    expect(parseDrawingTemplatesFile({ version: 1, tools: { brush: [] } })).toBeNull();
    expect(
      parseDrawingTemplatesFile({ version: 1, tools: { ray: [{ name: '', style }] } }),
    ).toBeNull();
  });
});
