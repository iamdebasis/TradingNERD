import { type DrawingLevel, defaultDrawingStyle } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  channelOffset,
  disjointChannel,
  dragChannelHandle,
  flatTopBottom,
  parallelChannel,
  placedPoints,
} from './channels';

const pane = { width: 400, height: 300 };
const pt = (x: number, y: number) => ({ x, y });
// A first line from (100, 200) up to (300, 100); a third point at x 200, 40 px under it.
const points = [pt(100, 200), pt(300, 100), pt(200, 190)];

describe('a parallel channel', () => {
  it('sits its second line at the third point’s distance under the first, wherever that point is', () => {
    expect(channelOffset(pt(100, 200), pt(300, 100), pt(200, 190))).toBe(40);
    expect(channelOffset(pt(100, 200), pt(300, 100), pt(100, 240))).toBe(40);
    expect(channelOffset(pt(100, 200), pt(300, 100), pt(300, 140))).toBe(40);
  });

  it('draws both lines, its dashed middle level, and one background across them', () => {
    const parts = parallelChannel(points, defaultDrawingStyle('parallel-channel'), pane);
    expect(parts?.lines).toEqual([
      [pt(100, 200), pt(300, 100)],
      [pt(100, 240), pt(300, 140)],
    ]);
    expect(parts?.looks).toEqual([
      {
        a: pt(100, 220),
        b: pt(300, 120),
        coeff: 0.5,
        color: '#2962FF',
        width: 1,
        lineStyle: 'dashed',
      },
    ]);
    expect(parts?.fills).toEqual([
      {
        points: [pt(100, 200), pt(300, 100), pt(300, 140), pt(100, 240)],
        color: '#2962FF33',
        opacity: 1,
      },
    ]);
    expect(parts?.fillsTakeClicks).toBe(true);
    expect(parts?.frame).toEqual({
      upper: [pt(100, 200), pt(300, 100)],
      lower: [pt(100, 240), pt(300, 140)],
    });
  });

  it('has six handles: both lines’ ends, then their middles, square', () => {
    const parts = parallelChannel(points, defaultDrawingStyle('parallel-channel'), pane);
    expect(parts?.handles.map(({ x, y, point, square }) => [x, y, point, square])).toEqual([
      [100, 200, 0, false],
      [300, 100, 1, false],
      [100, 240, 2, false],
      [300, 140, 3, false],
      [200, 190, 4, true],
      [200, 150, 5, true],
    ]);
  });

  it('spreads its background to a level shown outside it, and drops it when turned off', () => {
    const style = defaultDrawingStyle('parallel-channel');
    style.levels[0] = { ...(style.levels[0] as DrawingLevel), visible: true };
    expect(parallelChannel(points, style, pane)?.fills[0]?.points).toEqual([
      pt(100, 190),
      pt(300, 90),
      pt(300, 140),
      pt(100, 240),
    ]);
    style.fill.on = false;
    expect(parallelChannel(points, style, pane)?.fills).toEqual([]);
  });

  it('runs its lines to the pane’s edge when extended right', () => {
    const style = defaultDrawingStyle('parallel-channel');
    style.extendRight = true;
    const first = parallelChannel(points, style, pane)?.lines[0];
    expect(first?.[0]).toEqual(pt(100, 200));
    expect(first?.[1]).toEqual(pt(404, 48));
  });
});

describe('a flat top/bottom', () => {
  it('lays its flat line at the third point’s price over the sloped line’s bars, filled between', () => {
    const parts = flatTopBottom(
      [pt(100, 200), pt(300, 100), pt(250, 260)],
      defaultDrawingStyle('flat-top-bottom'),
      pane,
    );
    expect(parts?.lines).toEqual([
      [pt(100, 200), pt(300, 100)],
      [pt(100, 260), pt(300, 260)],
    ]);
    expect(parts?.fills[0]).toEqual({
      points: [pt(100, 200), pt(300, 100), pt(300, 260), pt(100, 260)],
      color: '#FF980033',
      opacity: 1,
    });
    expect(parts?.handles.map(({ x, y, square }) => [x, y, square])).toEqual([
      [100, 200, false],
      [300, 100, false],
      [100, 260, true],
      [300, 260, true],
    ]);
  });
});

describe('a disjoint channel', () => {
  it('mirrors its first line, ending at the third point’s price at the second point’s bar', () => {
    const parts = disjointChannel(
      [pt(100, 200), pt(300, 100), pt(250, 260)],
      defaultDrawingStyle('disjoint-channel'),
      pane,
    );
    // Up 100 px over 200 for the first line, down 100 px over the same for the second.
    expect(parts?.lines).toEqual([
      [pt(100, 200), pt(300, 100)],
      [pt(100, 160), pt(300, 260)],
    ]);
    expect(parts?.fills[0]?.points).toEqual([
      pt(100, 200),
      pt(300, 100),
      pt(300, 260),
      pt(100, 160),
    ]);
    expect(parts?.handles.map(({ x, y, point }) => [x, y, point])).toEqual([
      [100, 200, 0],
      [300, 100, 1],
      [300, 260, 2],
      [100, 160, 3],
    ]);
  });
});

describe('a channel’s points once placed (bars across, screen y down)', () => {
  it('keeps a parallel channel’s third point at its first point’s bar, at its offset', () => {
    expect(placedPoints('parallel-channel', [pt(10, 200), pt(30, 100), pt(20, 190)])).toEqual([
      pt(10, 200),
      pt(30, 100),
      pt(10, 240),
    ]);
  });

  it('keeps a flat top/bottom’s and disjoint channel’s third at the second point’s bar', () => {
    for (const tool of ['flat-top-bottom', 'disjoint-channel'] as const) {
      expect(placedPoints(tool, [pt(10, 200), pt(30, 100), pt(20, 260)])[2]).toEqual(pt(30, 260));
    }
  });
});

describe('dragging a channel’s handle (bars across, screen y down)', () => {
  const kept = [pt(10, 200), pt(30, 100), pt(10, 240)];

  it('keeps a parallel channel’s width when an end moves, from either line', () => {
    expect(dragChannelHandle('parallel-channel', kept, 0, pt(12, 210))).toEqual([
      pt(12, 210),
      pt(30, 100),
      pt(12, 250),
    ]);
    expect(dragChannelHandle('parallel-channel', kept, 1, pt(32, 90))).toEqual([
      pt(10, 200),
      pt(32, 90),
      pt(10, 240),
    ]);
    expect(dragChannelHandle('parallel-channel', kept, 2, pt(8, 260))).toEqual([
      pt(8, 220),
      pt(30, 100),
      pt(8, 260),
    ]);
    expect(dragChannelHandle('parallel-channel', kept, 3, pt(34, 150))).toEqual([
      pt(10, 200),
      pt(34, 110),
      pt(10, 240),
    ]);
  });

  it('sets a parallel channel’s width by its second line’s middle, and moves it by its first’s', () => {
    expect(dragChannelHandle('parallel-channel', kept, 4, pt(20, 170))).toEqual([
      pt(10, 200),
      pt(30, 100),
      pt(10, 220),
    ]);
    expect(dragChannelHandle('parallel-channel', kept, 5, pt(25, 140))).toEqual([
      pt(10, 190),
      pt(30, 90),
      pt(10, 230),
    ]);
  });

  it('moves only a flat top/bottom’s flat price by its flat line’s handles', () => {
    const flat = [pt(10, 200), pt(30, 100), pt(30, 260)];
    expect(dragChannelHandle('flat-top-bottom', flat, 2, pt(5, 280))).toEqual([
      pt(10, 200),
      pt(30, 100),
      pt(30, 280),
    ]);
    expect(dragChannelHandle('flat-top-bottom', flat, 1, pt(35, 120))).toEqual([
      pt(10, 200),
      pt(35, 120),
      pt(35, 260),
    ]);
  });

  it('mirrors a disjoint channel’s second line’s start onto its first point’s price', () => {
    const disjoint = [pt(10, 200), pt(30, 100), pt(30, 260)];
    // Its start sits at (10, 160); dragged to (10, 150), point 1 goes to 210.
    expect(dragChannelHandle('disjoint-channel', disjoint, 3, pt(10, 150))).toEqual([
      pt(10, 210),
      pt(30, 100),
      pt(30, 260),
    ]);
    expect(dragChannelHandle('disjoint-channel', disjoint, 2, pt(28, 270))?.[2]).toEqual(
      pt(30, 270),
    );
  });

  it('leaves a handle that moves its own point to the caller', () => {
    expect(dragChannelHandle('pitchfork', kept, 0, pt(1, 1))).toBeNull();
    expect(dragChannelHandle('trend-line', kept, 0, pt(1, 1))).toBeNull();
  });
});
