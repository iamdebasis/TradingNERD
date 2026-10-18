import type { Page } from '@playwright/test';
import {
  type ChartState,
  chartCall,
  chartState,
  dispatchWheel,
  expect,
  indexAtX,
  openChart,
  paneOrigin,
  settle,
  spacingOf,
  test,
} from './fixtures';

/**
 * The gesture map from docs/SPEC.md §4.2, checked against the chart's own model: which bar
 * stays under which pixel, how far a swipe pans, and what auto-scale does.
 */
async function open(page: Page) {
  const state = await openChart(page);
  const origin = await paneOrigin(page);
  return { state, origin };
}

const range = (state: ChartState) => {
  if (!state.logicalRange) throw new Error('no visible range');
  return state.logicalRange;
};

async function settled(page: Page): Promise<ChartState> {
  await settle(page);
  return chartState(page);
}

const prices = (state: ChartState) => {
  if (!state.priceRange) throw new Error('no price range');
  return state.priceRange;
};
const priceSpan = (state: ChartState) => prices(state).to - prices(state).from;
const priceMiddle = (state: ChartState) => (prices(state).from + prices(state).to) / 2;
/** Pane x of the middle of the price axis. */
const priceAxisX = (state: ChartState) => state.paneWidth + state.priceAxisWidth / 2;

test('the mouse wheel zooms with the right edge fixed', async ({ page }) => {
  const { state } = await open(page);
  await dispatchWheel(page, 400, 400, [{ deltaY: -100 }]); // one notch up = zoom in
  const zoomed = await settled(page);
  expect(range(zoomed).to).toBeCloseTo(range(state).to, 6);
  expect(spacingOf(range(zoomed), zoomed.width)).toBeCloseTo(6.6, 3);

  await dispatchWheel(page, 400, 400, [{ deltaY: 100 }]); // one notch down = zoom out
  const back = await settled(page);
  expect(spacingOf(range(back), back.width)).toBeCloseTo(6.6 * 0.9, 3);
});

test('Ctrl/⌘ + wheel zooms around the cursor', async ({ page }) => {
  const { state } = await open(page);
  const x = 400;
  await dispatchWheel(page, x, 400, [{ deltaY: -100, ctrlKey: true }]);
  const after = await settled(page);
  expect(indexAtX(range(after), after.width, x)).toBeCloseTo(
    indexAtX(range(state), state.width, x),
    4,
  );
  expect(spacingOf(range(after), after.width)).toBeCloseTo(6.6, 3);
});

test('a trackpad pinch: many small Ctrl + wheel steps in one frame all count', async ({ page }) => {
  const { state } = await open(page);
  const x = 900;
  // A 120 Hz trackpad delivers several events per 60 Hz frame; none may be lost.
  await dispatchWheel(page, x, 400, Array(8).fill({ deltaY: -5, ctrlKey: true }));
  const after = await settled(page);
  expect(spacingOf(range(after), after.width)).toBeCloseTo(6 * 1.005 ** 8, 4);
  expect(indexAtX(range(after), after.width, x)).toBeCloseTo(
    indexAtX(range(state), state.width, x),
    3,
  );
});

test('a sideways swipe pans 0.8 px per wheel pixel toward newer bars', async ({ page }) => {
  const { state } = await open(page);
  await dispatchWheel(page, 600, 400, [{ deltaX: 60 }]);
  const after = await settled(page);
  expect(range(after).to - range(state).to).toBeCloseTo((60 * 0.8) / 6, 3);
  expect(after.autoScale).toBe(true);
});

test('Shift + wheel pans as well', async ({ page }) => {
  const { state } = await open(page);
  await dispatchWheel(page, 600, 400, [{ deltaY: 60, shiftKey: true }]);
  const after = await settled(page);
  expect(range(after).to - range(state).to).toBeCloseTo((60 * 0.8) / 6, 3);
});

test('real wheel input reaches the chart and stops the page from scrolling', async ({ page }) => {
  const { state, origin } = await open(page);
  await page.mouse.move(origin.x + 400, origin.y + 400);
  await page.mouse.wheel(0, -200); // Chromium delivers -100 at 2× device scale
  const after = await settled(page);
  expect(spacingOf(range(after), after.width)).toBeGreaterThan(
    spacingOf(range(state), state.width),
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('a wheel step up over the price axis stretches the prices around their middle, not time', async ({
  page,
}) => {
  const { state } = await open(page);
  await dispatchWheel(page, priceAxisX(state), 300, [{ deltaY: -100 }]);
  const after = await settled(page);
  expect(after.logicalRange).toEqual(state.logicalRange);
  expect(after.autoScale).toBe(false);
  expect(priceSpan(after)).toBeCloseTo(priceSpan(state) / 1.1, 9);
  expect(priceMiddle(after)).toBeCloseTo(priceMiddle(state), 9);
});

test('a wheel step down over the price axis squeezes the prices', async ({ page }) => {
  const { state } = await open(page);
  await dispatchWheel(page, priceAxisX(state), 600, [{ deltaY: 100 }]);
  const after = await settled(page);
  expect(priceSpan(after)).toBeCloseTo(priceSpan(state) / 0.9, 9);
  expect(after.logicalRange).toEqual(state.logicalRange);
});

test('every price-axis wheel event in a frame counts', async ({ page }) => {
  const { state } = await open(page);
  await dispatchWheel(page, priceAxisX(state), 300, Array(8).fill({ deltaY: -5 }));
  const after = await settled(page);
  expect(priceSpan(after)).toBeCloseTo(priceSpan(state) / 1.005 ** 8, 9);
});

test('a sideways swipe over the price axis still pans', async ({ page }) => {
  const { state } = await open(page);
  await dispatchWheel(page, priceAxisX(state), 300, [{ deltaX: 60 }]);
  const after = await settled(page);
  expect(range(after).to - range(state).to).toBeCloseTo((60 * 0.8) / 6, 3);
  expect(after.autoScale).toBe(true);
});

test('the wheel over the time axis still zooms time', async ({ page }) => {
  const { state } = await open(page);
  await dispatchWheel(page, 600, state.paneHeight + 10, [{ deltaY: -100 }]);
  const after = await settled(page);
  expect(spacingOf(range(after), after.width)).toBeCloseTo(6.6, 3);
  expect(after.autoScale).toBe(true);
});

test('real wheel input over the price axis stretches prices; double-click undoes it', async ({
  page,
}) => {
  const { state, origin } = await open(page);
  await page.mouse.move(origin.x + priceAxisX(state), origin.y + 300);
  await page.mouse.wheel(0, -200); // Chromium delivers -100 at 2× device scale
  const after = await settled(page);
  expect(priceSpan(after)).toBeLessThan(priceSpan(state) * 0.95);
  expect(after.logicalRange).toEqual(state.logicalRange);
  expect(after.autoScale).toBe(false);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.mouse.dblclick(origin.x + priceAxisX(state), origin.y + 300);
  await expect.poll(async () => (await chartState(page)).autoScale).toBe(true);
  await expect.poll(async () => priceSpan(await chartState(page))).toBeCloseTo(priceSpan(state), 9);
});

test('dragging the chart pans it bar for bar', async ({ page }) => {
  const { state, origin } = await open(page);
  await page.mouse.move(origin.x + 600, origin.y + 400);
  await page.mouse.down();
  // A slow drag, so no flick momentum is added.
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(origin.x + 600 + i * 3, origin.y + 400);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(150);
  await page.mouse.up();
  const after = await settled(page);
  // Dragging right by 60 px shows up to 10 older bars (6 px each). Lightweight Charts starts
  // tracking on the first move events, so the first few pixels of a drag don't scroll.
  const shift = range(after).to - range(state).to;
  expect(shift).toBeLessThanOrEqual(-8);
  expect(shift).toBeGreaterThanOrEqual(-10.01);
  expect(after.autoScale).toBe(true);
});

test('a quick flick keeps gliding after release', async ({ page }) => {
  const { origin } = await open(page);
  await page.mouse.move(origin.x + 700, origin.y + 400);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(origin.x + 700 + i * 40, origin.y + 400);
  await page.mouse.up();
  const released = await settled(page);
  await page.waitForTimeout(400);
  const later = await chartState(page);
  // Still moving toward older bars after the button came up.
  expect(range(later).to).toBeLessThan(range(released).to - 1);
});

test('dragging up or down turns auto-scale off and the prices follow the pointer', async ({
  page,
}) => {
  const { origin } = await open(page);
  const grabbed = await chartCall<number>(page, 'yToPrice', 300); // the price under the pointer
  await page.mouse.move(origin.x + 600, origin.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(origin.x + 600, origin.y + 300 + i * 10);
  const during = await settled(page);
  expect(during.autoScale).toBe(false);
  // 100 px down: the grabbed price is now 100 px lower, still under the pointer.
  expect(await chartCall<number>(page, 'priceToY', grabbed)).toBeCloseTo(400, 0);
  await page.mouse.up();
});

test('a horizontal drag with a little wobble keeps auto-scale on', async ({ page }) => {
  const { origin } = await open(page);
  await page.mouse.move(origin.x + 600, origin.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(origin.x + 600 - i * 10, origin.y + 300 + (i % 2 === 0 ? 3 : -3));
  }
  await page.mouse.up();
  expect((await settled(page)).autoScale).toBe(true);
});

test('double-clicking the price axis turns auto-scale back on', async ({ page }) => {
  const { origin } = await open(page);
  await page.mouse.move(origin.x + 600, origin.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(origin.x + 600, origin.y + 300 + i * 10);
  await page.mouse.up();
  const dragged = await settled(page);
  expect(dragged.autoScale).toBe(false);
  await page.mouse.dblclick(origin.x + dragged.paneWidth + 30, origin.y + 300);
  await expect.poll(async () => (await chartState(page)).autoScale).toBe(true);
});

test('keyboard: arrows step, Ctrl/⌘ + arrows jump and zoom, Alt + R resets', async ({ page }) => {
  const { state } = await open(page);
  await page.keyboard.press('ArrowLeft');
  expect((await settled(page)).scrollPosition).toBeCloseTo(state.scrollPosition - 1, 6);
  await page.keyboard.press('ControlOrMeta+ArrowLeft');
  expect((await settled(page)).scrollPosition).toBeCloseTo(state.scrollPosition - 11, 6);
  await page.keyboard.press('ArrowRight');
  expect((await settled(page)).scrollPosition).toBeCloseTo(state.scrollPosition - 10, 6);

  const beforeZoom = await chartState(page);
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  const zoomed = await settled(page);
  expect(spacingOf(range(zoomed), zoomed.width)).toBeCloseTo(6.6, 3);
  expect(range(zoomed).to).toBeCloseTo(range(beforeZoom).to, 6);

  await page.keyboard.press('Alt+KeyR');
  const reset = await settled(page);
  expect(reset.scrollPosition).toBeCloseTo(10, 6);
  expect(spacingOf(range(reset), reset.width)).toBeCloseTo(6, 6);
  expect(reset.autoScale).toBe(true);
});

test('held arrow keys never lose steps', async ({ page }) => {
  const { state } = await open(page);
  // Five repeats inside one frame, as a fast key repeat can produce.
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    }
  });
  expect((await settled(page)).scrollPosition).toBeCloseTo(state.scrollPosition - 5, 6);
});
