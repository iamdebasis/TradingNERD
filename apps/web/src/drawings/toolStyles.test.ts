import { type Drawing, defaultDrawingStyle, newDrawing } from '@tradingnerd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_STYLES_KEY, parseLastStyles, ToolStyles } from './toolStyles';

let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const line = (id: string, tool: 'trend-line' | 'ray' = 'trend-line'): Drawing =>
  newDrawing(id, tool, [
    { time: 1, price: 1 },
    { time: 2, price: 2 },
  ]);

/** A drawing in another color and width, with text of its own. */
const restyled = (drawing: Drawing, color: string, width = 3): Drawing => ({
  ...drawing,
  style: { ...drawing.style, color, width, text: { ...drawing.style.text, value: 'Note' } },
});

describe('a tool’s last style (D3b)', () => {
  it('remembers the style an edit gives a drawing, for its tool, without its text', () => {
    const styles = new ToolStyles();
    const before = [line('a'), line('r', 'ray')];
    styles.remember(before, [restyled(line('a'), '#F23645'), line('r', 'ray')]);
    expect(styles.styleOf('trend-line')).toEqual({
      ...defaultDrawingStyle('trend-line'),
      color: '#F23645',
      width: 3,
    });
    expect(styles.styleOf('ray')).toBeUndefined();
  });

  it('takes the top one of a tool’s when several changed', () => {
    const styles = new ToolStyles();
    styles.remember(
      [line('a'), line('b')],
      [restyled(line('a'), '#F23645'), restyled(line('b'), '#089981')],
    );
    expect(styles.styleOf('trend-line')?.color).toBe('#089981');
  });

  it('leaves it for an edit that changes no style: a move, a lock, the text alone', () => {
    const styles = new ToolStyles();
    const a = line('a');
    styles.remember(
      [a],
      [
        {
          ...a,
          locked: true,
          points: [
            { time: 5, price: 5 },
            { time: 6, price: 6 },
          ],
          style: { ...a.style, text: { ...a.style.text, value: 'Only the text' } },
        },
      ],
    );
    expect(styles.styleOf('trend-line')).toBeUndefined();
    expect(stored.has(LAST_STYLES_KEY)).toBe(false);
  });

  it('keeps the styles in this browser, for the next page', () => {
    new ToolStyles().set('ray', { ...defaultDrawingStyle('ray'), color: '#FF9800' });
    expect(new ToolStyles().styleOf('ray')?.color).toBe('#FF9800');
  });

  it('works on in this page when this browser can’t keep them', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    const styles = new ToolStyles();
    styles.set('trend-line', { ...defaultDrawingStyle('trend-line'), width: 4 });
    expect(styles.styleOf('trend-line')?.width).toBe(4);
  });

  it('reads what was kept over each tool’s defaults, leaving out what isn’t a style', () => {
    const parsed = parseLastStyles({
      version: 1,
      tools: {
        pitchfork: { color: '#ffb74d', text: { value: 'not kept' } },
        brush: { color: '#000000' },
        ray: 'red',
      },
    });
    expect(Object.keys(parsed)).toEqual(['pitchfork']);
    expect(parsed.pitchfork?.color).toBe('#FFB74D');
    expect(parsed.pitchfork?.text.value).toBe('');
    expect(parsed.pitchfork?.levels).toEqual(defaultDrawingStyle('pitchfork').levels);
    expect(parseLastStyles({ version: 2, tools: { ray: {} } })).toEqual({});
    expect(parseLastStyles(null)).toEqual({});
  });
});
