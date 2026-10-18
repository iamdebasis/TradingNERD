import type { Page } from '@playwright/test';
import {
  type ChartState,
  chartCall,
  chartState,
  chartTuning,
  dispatchWheel,
  expect,
  type GestureTuning,
  openChart,
  settle,
  spacingOf,
  test,
} from './fixtures';

/**
 * The TEMPORARY dev-only gesture tuning panel (`?tune`), used to calibrate the gesture constants
 * against TradingView side by side. Every change must reach the chart at once.
 */
const DEFAULTS: GestureTuning = {
  zoomStep: 0.1,
  pinchStep: 0.1,
  panFactor: 0.8,
  priceStep: 0.1,
  priceAnchor: 'center',
  priceReversed: false,
};

const panel = (page: Page) => page.getByRole('region', { name: 'Gesture tuning' });
const slider = (page: Page, name: string) => panel(page).getByRole('slider', { name });

/** Moves a slider and waits until the chart has the new value. */
async function setSlider(page: Page, name: string, key: keyof GestureTuning, value: number) {
  await slider(page, name).fill(String(value));
  await expect.poll(async () => (await chartTuning(page))[key]).toBe(value);
}

async function settled(page: Page): Promise<ChartState> {
  await settle(page);
  return chartState(page);
}

const range = (state: ChartState) => {
  if (!state.logicalRange) throw new Error('no visible range');
  return state.logicalRange;
};
const priceSpan = (state: ChartState) => {
  if (!state.priceRange) throw new Error('no price range');
  return state.priceRange.to - state.priceRange.from;
};
/** Pane x of the middle of the price axis. */
const priceAxisX = (state: ChartState) => state.paneWidth + state.priceAxisWidth / 2;

test('the panel only appears with ?tune, and collapses', async ({ page }) => {
  await openChart(page);
  await expect(panel(page)).toHaveCount(0);

  await openChart(page, '/?tune');
  await expect(panel(page)).toBeVisible();
  await expect(slider(page, 'Chart zoom')).toHaveValue('0.1');
  await expect(slider(page, 'Pinch zoom')).toHaveValue('0.1');
  await expect(slider(page, 'Sideways pan')).toHaveValue('0.8');
  await expect(slider(page, 'Price-axis swipe')).toHaveValue('0.1');
  await expect(panel(page).getByRole('radio', { name: 'Middle' })).toBeChecked();
  await expect(panel(page).getByRole('checkbox', { name: 'Reverse' })).not.toBeChecked();
  expect(await chartTuning(page)).toEqual(DEFAULTS);

  await panel(page).getByRole('button', { name: 'Hide' }).click();
  await expect(slider(page, 'Chart zoom')).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Show' }).click();
  await expect(slider(page, 'Chart zoom')).toBeVisible();
});

test('price-axis speed, fixed point and direction apply at once', async ({ page }) => {
  const state = await openChart(page, '/?tune');
  const x = priceAxisX(state);

  await setSlider(page, 'Price-axis swipe', 'priceStep', 0.2);
  await dispatchWheel(page, x, 300, [{ deltaY: -100 }]);
  const faster = await settled(page);
  expect(priceSpan(faster)).toBeCloseTo(priceSpan(state) / 1.2, 9);

  // Pointer: the price under the pointer stays under it.
  await panel(page).getByRole('radio', { name: 'Pointer' }).check();
  await expect.poll(async () => (await chartTuning(page)).priceAnchor).toBe('pointer');
  const grabbed = await chartCall<number>(page, 'yToPrice', 250);
  await dispatchWheel(page, x, 250, [{ deltaY: -100 }]);
  const pointer = await settled(page);
  expect(priceSpan(pointer)).toBeCloseTo(priceSpan(faster) / 1.2, 9);
  expect(await chartCall<number>(page, 'priceToY', grabbed)).toBeCloseTo(250, 6);

  // Last price: the latest close stays put wherever the pointer is.
  await panel(page).getByRole('radio', { name: 'Last price' }).check();
  await expect.poll(async () => (await chartTuning(page)).priceAnchor).toBe('lastPrice');
  const lastY = await chartCall<number>(page, 'priceToY', 1.2955);
  await dispatchWheel(page, x, 600, [{ deltaY: 100 }]);
  const last = await settled(page);
  expect(priceSpan(last)).toBeCloseTo(priceSpan(pointer) / 0.8, 9);
  expect(await chartCall<number>(page, 'priceToY', 1.2955)).toBeCloseTo(lastY, 6);

  // Reversed: a wheel step up now squeezes.
  await panel(page).getByRole('checkbox', { name: 'Reverse' }).check();
  await expect.poll(async () => (await chartTuning(page)).priceReversed).toBe(true);
  await dispatchWheel(page, x, 300, [{ deltaY: -100 }]);
  const reversed = await settled(page);
  expect(priceSpan(reversed)).toBeCloseTo(priceSpan(last) / 0.8, 9);
  expect(reversed.logicalRange).toEqual(state.logicalRange);
});

test('chart zoom, pinch and pan speeds apply at once', async ({ page }) => {
  await openChart(page, '/?tune');

  await setSlider(page, 'Chart zoom', 'zoomStep', 0.2);
  await dispatchWheel(page, 700, 400, [{ deltaY: -100 }]);
  const zoomed = await settled(page);
  expect(spacingOf(range(zoomed), zoomed.width)).toBeCloseTo(6 * 1.2, 3);

  await setSlider(page, 'Pinch zoom', 'pinchStep', 0.05);
  await dispatchWheel(page, 700, 400, [{ deltaY: -100, ctrlKey: true }]);
  const pinched = await settled(page);
  expect(spacingOf(range(pinched), pinched.width)).toBeCloseTo(6 * 1.2 * 1.05, 3);

  await setSlider(page, 'Sideways pan', 'panFactor', 1.6);
  await dispatchWheel(page, 700, 400, [{ deltaX: 60 }]);
  const panned = await settled(page);
  const spacing = spacingOf(range(pinched), pinched.width);
  expect(range(panned).to - range(pinched).to).toBeCloseTo((60 * 1.6) / spacing, 3);
});

test('values survive a reload, only apply with ?tune, and reset to the defaults', async ({
  page,
}) => {
  await openChart(page, '/?tune');
  await setSlider(page, 'Price-axis swipe', 'priceStep', 0.3);
  await panel(page).getByRole('radio', { name: 'Pointer' }).check();
  await expect.poll(async () => (await chartTuning(page)).priceAnchor).toBe('pointer');

  await openChart(page, '/?tune');
  await expect(slider(page, 'Price-axis swipe')).toHaveValue('0.3');
  await expect(panel(page).getByRole('radio', { name: 'Pointer' })).toBeChecked();
  await expect
    .poll(() => chartTuning(page))
    .toEqual({ ...DEFAULTS, priceStep: 0.3, priceAnchor: 'pointer' });

  // Without ?tune the chart keeps the defaults, so nothing changes silently.
  await openChart(page);
  expect(await chartTuning(page)).toEqual(DEFAULTS);

  await openChart(page, '/?tune');
  await panel(page).getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(slider(page, 'Price-axis swipe')).toHaveValue('0.1');
  await expect.poll(() => chartTuning(page)).toEqual(DEFAULTS);
  await openChart(page, '/?tune');
  await expect.poll(() => chartTuning(page)).toEqual(DEFAULTS);
});

test('Copy values puts the values on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openChart(page, '/?tune');
  await setSlider(page, 'Chart zoom', 'zoomStep', 0.15);
  await panel(page).getByRole('button', { name: 'Copy values' }).click();
  await expect(panel(page).getByRole('button', { name: 'Copied' })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(text)).toEqual({ ...DEFAULTS, zoomStep: 0.15 });
});
