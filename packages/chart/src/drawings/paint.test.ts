import { describe, expect, it } from 'vitest';
import { cutSegment, fillArea, layoutText, textOn, withAlpha } from './paint';

/** A canvas context that measures text at 6 px a character, as the tests need no more. */
const ctx = {
  font: '',
  save() {},
  restore() {},
  measureText: (text: string) => ({ width: text.length * 6 }),
} as unknown as CanvasRenderingContext2D;

const look = { value: 'Hello', color: '#2962FF', size: 12, bold: false, italic: false };

describe('withAlpha', () => {
  it('gives a color at an opacity, its own opacity kept', () => {
    expect(withAlpha('#2962FF', 0.25)).toBe('rgba(41, 98, 255, 0.25)');
    expect(withAlpha('#2962FF80', 0.5)).toBe('rgba(41, 98, 255, 0.251)');
  });
});

describe('textOn', () => {
  it('writes black on a light label and white on a dark one', () => {
    expect(textOn('#FFEB3B')).toBe('#000000');
    expect(textOn('#2962FF')).toBe('#FFFFFF');
  });
});

describe('layoutText', () => {
  const from = { x: 100, y: 200 };
  const to = { x: 300, y: 200 };

  it('reads left to right whichever way the line was drawn', () => {
    const layout = layoutText(ctx, to, from, look, 'sans-serif', 'left', 'above');
    expect(layout?.origin).toEqual(from);
    expect(layout?.angle).toBe(0);
    // A third of its size in from the left end, its bottom a third above the line.
    expect(layout?.x).toBe(4);
    expect(layout?.top).toBe(-4 - 12);
  });

  it('centres along the line and sits below it for the top alignment', () => {
    const layout = layoutText(ctx, from, to, look, 'sans-serif', 'center', 'below');
    expect(layout?.x).toBe((200 - 30) / 2);
    expect(layout?.top).toBe(4);
    expect(layout?.gap).toBeNull();
  });

  it('leaves a gap in the line for text on it', () => {
    const layout = layoutText(ctx, from, to, look, 'sans-serif', 'right', 'on');
    // 30 px of text ending 4 px in from the right end, and 4 px either side of it.
    expect(layout?.gap).toEqual([
      { x: 100 + 166 - 4, y: 200 },
      { x: 100 + 196 + 4, y: 200 },
    ]);
  });

  it('turns with the line', () => {
    const layout = layoutText(ctx, from, { x: 200, y: 100 }, look, 'sans-serif', 'left', 'above');
    expect(layout?.angle).toBeCloseTo(-Math.PI / 4, 12);
  });

  it('has nothing to lay out for blank text', () => {
    expect(layoutText(ctx, from, to, { ...look, value: ' \n ' }, 'x', 'left', 'on')).toBeNull();
  });
});

describe('cutSegment', () => {
  const segment: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];

  it('leaves out the part between the gap’s ends', () => {
    expect(
      cutSegment(segment, [
        { x: 40, y: 0 },
        { x: 60, y: 0 },
      ]),
    ).toEqual([
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
      ],
      [
        { x: 60, y: 0 },
        { x: 100, y: 0 },
      ],
    ]);
  });

  it('keeps one piece when the gap runs past an end, none when it covers it all', () => {
    expect(
      cutSegment(segment, [
        { x: 80, y: 0 },
        { x: 120, y: 0 },
      ]),
    ).toEqual([
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
      ],
    ]);
    expect(
      cutSegment(segment, [
        { x: -10, y: 0 },
        { x: 110, y: 0 },
      ]),
    ).toEqual([]);
  });
});

describe('fillArea', () => {
  /** A context that writes down the path it's given and the color it's filled with. */
  function recorder() {
    const calls: string[] = [];
    const context = {
      fillStyle: '',
      save() {},
      restore() {},
      beginPath: () => calls.push('begin'),
      moveTo: (x: number, y: number) => calls.push(`move ${x} ${y}`),
      lineTo: (x: number, y: number) => calls.push(`line ${x} ${y}`),
      closePath: () => calls.push('close'),
      fill() {
        calls.push(`fill ${context.fillStyle}`);
      },
    };
    return { calls, context: context as unknown as CanvasRenderingContext2D };
  }

  it('fills the area through its corners in its color at its opacity', () => {
    const { calls, context } = recorder();
    fillArea(
      context,
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
      ],
      '#2962FF33',
      1,
    );
    expect(calls).toEqual([
      'begin',
      'move 0 0',
      'line 10 0',
      'line 10 5',
      'close',
      'fill rgba(41, 98, 255, 0.2)',
    ]);
  });

  it('fills nothing with fewer than three corners', () => {
    const { calls, context } = recorder();
    fillArea(
      context,
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      '#2962FF',
      0.2,
    );
    expect(calls).toEqual([]);
  });
});
