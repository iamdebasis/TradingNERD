import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

/**
 * Pixel checks against the TradingView reference screenshot (docs/reference/01-chart-layout.png).
 * It is a 2× Retina capture whose top 4 CSS px (8 device px) were cropped off, so reference row
 * `y` corresponds to row `y + CROP_TOP` of our full-window screenshot. Only neutral grays are
 * compared: they are identical in the reference's Display P3 and our sRGB, while other colors
 * would need color-profile conversion.
 */
const REFERENCE = fileURLToPath(
  new URL('../../../../docs/reference/01-chart-layout.png', import.meta.url),
);
const CROP_TOP = 8;
const GUTTER = 0x2e;
const SURFACE = 0x0f;

interface Image {
  width: number;
  height: number;
  data: Buffer;
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

const reference: Image = PNG.sync.read(readFileSync(REFERENCE));

test.describe('matches the TradingView reference pixels', () => {
  let ours: Image;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-gateway-status="connected"]')).toBeVisible();
    ours = PNG.sync.read(await page.screenshot());
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

  test('surfaces have the reference colors', () => {
    expect(isGray(ours, 1500, 30 + CROP_TOP, SURFACE)).toBe(true); // toolbar
    expect(isGray(ours, 1000, 900 + CROP_TOP, SURFACE)).toBe(true); // chart
    expect(isGray(ours, 2900, 1500 + CROP_TOP, SURFACE)).toBe(true); // watchlist
    expect(isGray(ours, 2625, 1000 + CROP_TOP, GUTTER)).toBe(true); // splitter
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
});
