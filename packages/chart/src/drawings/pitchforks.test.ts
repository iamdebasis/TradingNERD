import { defaultDrawingStyle } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import type { Pt } from './geometry';
import { pitchfork, pitchforkFrame, pitchforkGuides } from './pitchforks';

const pane = { width: 1_000, height: 600 };
const pt = (x: number, y: number) => ({ x, y });
// Point 1 low on the left, point 2 high, point 3 between: their middle is (250, 150).
const points = [pt(100, 300), pt(200, 100), pt(300, 200)];

describe('where each pitchfork’s median starts and which way it runs', () => {
  it('runs a Pitchfork’s from point 1 through the middle of points 2 and 3', () => {
    expect(pitchforkFrame('pitchfork', points)).toEqual({
      origin: pt(100, 300),
      direction: pt(150, -150),
      base: pt(250, 150),
      half: pt(50, 50),
    });
  });

  it('starts a Schiff’s at point 1’s bar, halfway to point 2 in price', () => {
    const frame = pitchforkFrame('schiff-pitchfork', points);
    expect([frame?.origin, frame?.direction]).toEqual([pt(100, 200), pt(150, -50)]);
  });

  it('starts a Modified Schiff’s halfway between points 1 and 2 in bar and price', () => {
    const frame = pitchforkFrame('modified-schiff-pitchfork', points);
    expect([frame?.origin, frame?.direction]).toEqual([pt(150, 200), pt(100, -50)]);
  });

  it('starts an Inside’s at the middle of points 2 and 3, running as from 1 and 2’s middle to 3', () => {
    const frame = pitchforkFrame('inside-pitchfork', points);
    expect([frame?.origin, frame?.direction]).toEqual([pt(250, 150), pt(150, 0)]);
  });

  it('has none when point 1 sits on the middle of points 2 and 3', () => {
    expect(pitchforkFrame('pitchfork', [pt(250, 150), pt(200, 100), pt(300, 200)])).toBeNull();
  });
});

describe('the lines a pitchfork draws from point 1, as TradingView does (its screenshot, 26 November)', () => {
  it('draws none for a Pitchfork, whose median starts at point 1', () => {
    expect(pitchforkGuides('pitchfork', points)).toEqual([]);
  });

  it('draws a Schiff’s and a Modified Schiff’s from point 1 to point 2', () => {
    for (const tool of ['schiff-pitchfork', 'modified-schiff-pitchfork'] as const) {
      expect(pitchforkGuides(tool, points), tool).toEqual([[pt(100, 300), pt(200, 100)]]);
    }
  });

  it('draws an Inside’s from point 1 to point 2, and from that line’s middle to point 3', () => {
    expect(pitchforkGuides('inside-pitchfork', points)).toEqual([
      [pt(100, 300), pt(200, 100)],
      [pt(150, 200), pt(300, 200)],
    ]);
  });

  it('starts a Modified Schiff’s median at the middle of its line from point 1', () => {
    const [[a, b]] = pitchforkGuides('modified-schiff-pitchfork', points) as [[Pt, Pt]];
    expect(pitchforkFrame('modified-schiff-pitchfork', points)?.origin).toEqual(
      pt((a.x + b.x) / 2, (a.y + b.y) / 2),
    );
  });

  it('runs an Inside’s median parallel to its second line', () => {
    const [, [a, b]] = pitchforkGuides('inside-pitchfork', points) as [[Pt, Pt], [Pt, Pt]];
    const direction = pitchforkFrame('inside-pitchfork', points)?.direction as Pt;
    expect(direction.x * (b.y - a.y) - direction.y * (b.x - a.x)).toBe(0);
  });

  it('leaves out a line of no length', () => {
    expect(pitchforkGuides('schiff-pitchfork', [pt(100, 300), pt(100, 300), pt(300, 200)])).toEqual(
      [],
    );
  });
});

describe('a pitchfork as drawn', () => {
  it('draws its median to the pane’s edge, the line from point 2 to 3, and its two levels each side', () => {
    const parts = pitchfork('pitchfork', points, defaultDrawingStyle('pitchfork'), pane);
    // Up and to the right at 45°: out through the top, 4 px past it.
    expect(parts?.lines).toEqual([
      [pt(100, 300), pt(404, -4)],
      [pt(200, 100), pt(300, 200)],
    ]);
    const starts = parts?.looks.map((look) => [look.a.x, look.a.y, look.coeff, look.color]);
    expect(starts).toEqual([
      [275, 175, 0.5, '#089981'],
      [300, 200, 1, '#2962FF'],
      [225, 125, 0.5, '#089981'],
      [200, 100, 1, '#2962FF'],
    ]);
  });

  it('fills from the median to the first level and on to the next, each side, in the outer level’s color', () => {
    const parts = pitchfork('pitchfork', points, defaultDrawingStyle('pitchfork'), pane);
    expect(parts?.fills.map((fill) => [fill.color, fill.points[0], fill.points[3]])).toEqual([
      ['#089981', pt(250, 150), pt(275, 175)],
      ['#2962FF', pt(275, 175), pt(300, 200)],
      ['#089981', pt(250, 150), pt(225, 125)],
      ['#2962FF', pt(225, 125), pt(200, 100)],
    ]);
    expect(parts?.fills.every((fill) => Math.abs(fill.opacity - 0.2) < 1e-9)).toBe(true);
    expect(parts?.fillsTakeClicks).toBe(false);
  });

  it('runs its lines back past their start with Extend lines', () => {
    const style = defaultDrawingStyle('pitchfork');
    style.extendLines = true;
    expect(pitchfork('pitchfork', points, style, pane)?.lines[0]).toEqual([
      pt(-4, 404),
      pt(404, -4),
    ]);
  });

  it('runs an Inside pitchfork’s lines flat from points 2 and 3 here', () => {
    const parts = pitchfork(
      'inside-pitchfork',
      points,
      defaultDrawingStyle('inside-pitchfork'),
      pane,
    );
    expect(parts?.lines[0]).toEqual([pt(250, 150), pt(1_004, 150)]);
    const tine = parts?.looks.find((look) => look.coeff === 1);
    expect([tine?.a, tine?.b]).toEqual([pt(300, 200), pt(1_004, 200)]);
  });

  it('draws its lines from point 1 after its median and its line from point 2 to 3', () => {
    for (const tool of ['schiff-pitchfork', 'modified-schiff-pitchfork'] as const) {
      expect(
        pitchfork(tool, points, defaultDrawingStyle(tool), pane)?.lines.slice(1),
        tool,
      ).toEqual([
        [pt(200, 100), pt(300, 200)],
        [pt(100, 300), pt(200, 100)],
      ]);
    }
    const inside = pitchfork(
      'inside-pitchfork',
      points,
      defaultDrawingStyle('inside-pitchfork'),
      pane,
    );
    expect(inside?.lines.slice(1)).toEqual([
      [pt(200, 100), pt(300, 200)],
      [pt(100, 300), pt(200, 100)],
      [pt(150, 200), pt(300, 200)],
    ]);
  });

  it('keeps its lines from point 1 with its median turned off, as its line from point 2 to 3', () => {
    const style = defaultDrawingStyle('schiff-pitchfork');
    style.lineVisible = false;
    expect(pitchfork('schiff-pitchfork', points, style, pane)?.lines).toEqual([
      [pt(200, 100), pt(300, 200)],
      [pt(100, 300), pt(200, 100)],
    ]);
  });

  it('cuts a line from point 1 at the pane’s edge, 4 px past it', () => {
    const off = [pt(-200, 300), pt(200, 100), pt(300, 200)];
    const [, guide] =
      pitchfork(
        'schiff-pitchfork',
        off,
        defaultDrawingStyle('schiff-pitchfork'),
        pane,
      )?.lines.slice(1) ?? [];
    expect(guide).toEqual([pt(-4, 202), pt(200, 100)]);
  });

  it('runs to the left edge when drawn leftwards', () => {
    const left = [pt(900, 300), pt(800, 100), pt(700, 200)];
    expect(pitchfork('pitchfork', left, defaultDrawingStyle('pitchfork'), pane)?.lines[0]).toEqual([
      pt(900, 300),
      pt(596, -4),
    ]);
  });

  it('leaves out its median when turned off, and its background when that is', () => {
    const style = defaultDrawingStyle('pitchfork');
    style.lineVisible = false;
    style.fill.on = false;
    const parts = pitchfork('pitchfork', points, style, pane);
    expect(parts?.lines).toEqual([[pt(200, 100), pt(300, 200)]]);
    expect(parts?.fills).toEqual([]);
  });

  it('draws an Inside’s lines from point 1 though its median has no direction', () => {
    // Point 3 at the middle of points 1 and 2: the second line has no length, the median none.
    const flat = [pt(100, 300), pt(200, 100), pt(150, 200)];
    const parts = pitchfork(
      'inside-pitchfork',
      flat,
      defaultDrawingStyle('inside-pitchfork'),
      pane,
    );
    expect(parts?.lines).toEqual([
      [pt(200, 100), pt(150, 200)],
      [pt(100, 300), pt(200, 100)],
    ]);
  });

  it('draws only the line from point 2 to 3 when it has no direction, and keeps its handles', () => {
    const parts = pitchfork(
      'pitchfork',
      [pt(250, 150), pt(200, 100), pt(300, 200)],
      defaultDrawingStyle('pitchfork'),
      pane,
    );
    expect(parts?.lines).toEqual([[pt(200, 100), pt(300, 200)]]);
    expect(parts?.handles.map((handle) => handle.point)).toEqual([0, 1, 2]);
  });
});
