import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { chartState, expect, openChart, test } from './fixtures';

/**
 * Pixel checks against the TradingView reference screenshot (docs/reference/01-chart-layout.png).
 * It is a 2× Retina capture whose top 4 CSS px (8 device px) were cropped off, so reference row
 * `y` corresponds to row `y + CROP_TOP` of our full-window screenshot. Neutral grays are
 * identical in the reference's Display P3 and our sRGB; colored pixels are matched with a
 * tolerance against the P3 values instead.
 */
const REFERENCE = fileURLToPath(
  new URL('../../../../docs/reference/01-chart-layout.png', import.meta.url),
);
const CROP_TOP = 8;
const GUTTER = 0x2e;
const SURFACE = 0x0f;
const GRID = 0x1c;

interface Image {
  width: number;
  height: number;
  data: Buffer;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function pixel(img: Image, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? -1, img.data[i + 1] ?? -1, img.data[i + 2] ?? -1];
}

const isGray = (img: Image, x: number, y: number, level: number) =>
  pixel(img, x, y).every((channel) => channel === level);

/** [start, end] runs of gutter-colored pixels along a row or column. */
function gutterRuns(img: Image, axis: 'row' | 'col', at: number, length: number) {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= length; i++) {
    const hit =
      i < length && (axis === 'row' ? isGray(img, i, at, GUTTER) : isGray(img, at, i, GUTTER));
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}

/** Mean absolute difference of the red channel over a square block (grays only). */
function blockDifference(a: Image, ax: number, ay: number, b: Image, bx: number, by: number) {
  const size = 12;
  let total = 0;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      total += Math.abs(pixel(a, ax + dx, ay + dy)[0] - pixel(b, bx + dx, by + dy)[0]);
    }
  }
  return total / (size * size);
}

/** Bounding box of the pixels in `area` that satisfy `match`, or null. */
function boundingBox(
  img: Image,
  area: Box,
  match: (rgb: [number, number, number]) => boolean,
): Box | null {
  let box: Box | null = null;
  for (let y = area.top; y < area.bottom; y++) {
    for (let x = area.left; x < area.right; x++) {
      if (!match(pixel(img, x, y))) continue;
      box = box
        ? {
            left: Math.min(box.left, x),
            top: Math.min(box.top, y),
            right: Math.max(box.right, x),
            bottom: Math.max(box.bottom, y),
          }
        : { left: x, top: y, right: x, bottom: y };
    }
  }
  return box;
}

const near = (rgb: [number, number, number], target: [number, number, number], tolerance: number) =>
  rgb.every((channel, i) => Math.abs(channel - (target[i] ?? 0)) <= tolerance);

const reference: Image = PNG.sync.read(readFileSync(REFERENCE));

async function settledScreenshot(page: Page): Promise<Image> {
  await openChart(page);
  await expect(page.locator('[data-book]')).toHaveAttribute('data-status', 'live');
  await page.mouse.move(0, 0); // no crosshair
  return PNG.sync.read(await page.screenshot());
}

test.describe('matches the TradingView reference pixels', () => {
  let ours: Image;

  test.beforeEach(async ({ page }) => {
    ours = await settledScreenshot(page);
  });

  test('screenshot scale matches the reference', () => {
    expect(ours.width).toBe(1634 * 2);
    expect(reference.width).toBe(3262);
  });

  test('vertical gutters line up exactly', () => {
    for (const y of [400, 1000, 1700]) {
      const expected = gutterRuns(reference, 'row', y, reference.width);
      expect(expected).toEqual([
        [0, 7],
        [2622, 2629],
        [3260, 3261],
      ]);
      expect(gutterRuns(ours, 'row', y + CROP_TOP, reference.width)).toEqual(expected);
    }
  });

  test('the gutter under the toolbar lines up exactly', () => {
    for (const x of [300, 1500, 2000]) {
      const expected = gutterRuns(reference, 'col', x, 300);
      expect(expected).toEqual([[68, 75]]);
      const actual = gutterRuns(ours, 'col', x, 300 + CROP_TOP).map(
        ([start, end]) => [start - CROP_TOP, end - CROP_TOP] as [number, number],
      );
      expect(actual).toEqual(expected);
    }
  });

  test('surfaces have the reference colors', async ({ page }) => {
    expect(isGray(ours, 1500, 30 + CROP_TOP, SURFACE)).toBe(true); // toolbar
    expect(isGray(ours, 2900, 1500 + CROP_TOP, SURFACE)).toBe(true); // watchlist
    expect(isGray(ours, 2625, 1000 + CROP_TOP, GUTTER)).toBe(true); // splitter
    // The chart canvas: the empty top-right corner of the pane holds only background or grid.
    const { paneWidth } = await chartState(page);
    for (let dx = 1; dx <= 6; dx++) {
      for (let dy = 1; dy <= 6; dy++) {
        const [r, g, b] = pixel(ours, (4 + paneWidth) * 2 - dx * 2, 42 * 2 + dy * 2);
        expect(r === g && g === b && (r === SURFACE || r === GRID)).toBe(true);
      }
    }
  });

  test('panel corners are rounded like the reference', () => {
    // Calibrated 2026-10-18: a 3.5 px radius scores 0.30–0.42 here, 3 px and 4 px score up to
    // 0.91, while 0, 2, 4.5 and 5 px score 1.38 or worse. The threshold therefore pins the
    // radius to within about ±0.5 px of the reference.
    // Top-left of chart, top-right of chart, top-left of watchlist (reference coordinates).
    const corners: [number, number][] = [
      [6, 74],
      [2612, 74],
      [2626, 74],
    ];
    for (const [x, y] of corners) {
      expect(blockDifference(ours, x, y + CROP_TOP, reference, x, y)).toBeLessThan(1);
    }
  });

  test('the last-price label matches TradingView in size and text placement', async ({ page }) => {
    // Both show "1.2955 / 07:50:06" in red. Search only the price axis, not the pane.
    const { paneWidth } = await chartState(page);
    const ourAxis: Box = { left: (4 + paneWidth) * 2, top: 84, right: 1311 * 2, bottom: 1900 };
    const refAxis: Box = { left: 2477, top: 76, right: 2622, bottom: 1900 };
    // Same tolerance on both sides, so both boxes include the same share of antialiased edge.
    const ourBox = boundingBox(ours, ourAxis, (rgb) => near(rgb, [242, 54, 69], 10));
    // The reference is Display P3, where TradingView's #F23645 is stored as about #DF484C.
    const refBox = boundingBox(reference, refAxis, (rgb) => near(rgb, [223, 72, 76], 10));
    if (!ourBox || !refBox) throw new Error('label not found');

    const size = (box: Box) => ({ w: box.right - box.left, h: box.bottom - box.top });
    expect(Math.abs(size(ourBox).w - size(refBox).w)).toBeLessThanOrEqual(4); // ≤ 2 CSS px
    expect(Math.abs(size(ourBox).h - size(refBox).h)).toBeLessThanOrEqual(2); // ≤ 1 CSS px

    // "1.2955" in the first row, measured from the box's top-left corner.
    const firstRow = (box: Box): Box => ({ ...box, bottom: box.top + 32 });
    const white = (rgb: [number, number, number]) => rgb.every((channel) => channel > 200);
    const ourText = boundingBox(ours, firstRow(ourBox), white);
    const refText = boundingBox(reference, firstRow(refBox), white);
    if (!ourText || !refText) throw new Error('label text not found');
    expect(Math.abs(ourText.left - ourBox.left - (refText.left - refBox.left))).toBeLessThanOrEqual(
      4,
    );
    expect(Math.abs(ourText.top - ourBox.top - (refText.top - refBox.top))).toBeLessThanOrEqual(4);
    expect(Math.abs(size(ourText).w - size(refText).w)).toBeLessThanOrEqual(4);
  });
});

test('the legend sits where TradingView puts it', async ({ page }) => {
  await openChart(page);
  const box = async (name: string) => {
    const found = await page.locator(`[data-field="${name}"]`).boundingBox();
    if (!found) throw new Error(`${name} not visible`);
    return found;
  };
  // Window coordinates measured from the reference (docs/SPEC.md §7.3), ±1.5 px.
  const sell = await box('sell');
  expect(sell.x).toBeCloseTo(13, 0);
  expect(sell.y).toBeCloseTo(74, 0);
  expect(sell.width).toBeCloseTo(65.5, 0);
  expect(sell.height).toBeCloseTo(34, 0);
  expect((await box('buy')).x).toBeCloseTo(129.5, 0);
  const title = await box('title');
  expect(Math.abs(title.x - 36)).toBeLessThanOrEqual(2);
  expect(Math.abs(title.y + title.height / 2 - 59)).toBeLessThanOrEqual(2);
});
