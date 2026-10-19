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
 * The top bar's Gestures button and popup (docs/SPEC.md §5.2): the gesture settings, applied
 * to the chart at once and kept in this browser, with the chart usable while it's open.
 */
const DEFAULTS: GestureTuning = {
  zoomStep: 0.1,
  pinchStep: 0.1,
  panFactor: 0.8,
  priceStep: 0.1,
  priceAnchor: 'center',
  priceReversed: false,
};

const button = (page: Page) => page.getByRole('banner').getByRole('button', { name: 'Gestures' });
const popup = (page: Page) => page.getByRole('region', { name: 'Gestures' });
const slider = (page: Page, name: string) => popup(page).getByRole('slider', { name, exact: true });

async function openPopup(page: Page) {
  await button(page).click();
  await expect(popup(page)).toBeVisible();
}

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
/** A point on the chart clear of the popup, which hangs over the middle of the pane. */
const CLEAR = { x: 300, y: 600 };

test('the Gestures button opens the popup under it; it, ✕ and Escape close it', async ({
  page,
}) => {
  await openChart(page);
  const menu = page.getByRole('banner').getByRole('button', { name: 'Interval menu' });
  const [gestures, intervals] = [await button(page).boundingBox(), await menu.boundingBox()];
  expect(gestures?.x).toBeGreaterThan((intervals?.x ?? 0) + (intervals?.width ?? 0));
  await expect(popup(page)).toHaveCount(0);

  await openPopup(page);
  const box = await popup(page).boundingBox();
  expect(box?.x).toBe(gestures?.x);
  expect(box?.y).toBe((gestures?.y ?? 0) + (gestures?.height ?? 0) + 2);
  await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(slider(page, 'Zoom')).toHaveValue('0.1');
  await expect(slider(page, 'Pinch zoom')).toHaveValue('0.1');
  await expect(slider(page, 'Scroll')).toHaveValue('0.8');
  await expect(slider(page, 'Price scale')).toHaveValue('0.1');
  await expect(popup(page).getByRole('radio', { name: 'Middle' })).toBeChecked();
  await expect(popup(page).getByRole('checkbox', { name: 'Reverse' })).not.toBeChecked();
  await expect(popup(page).getByRole('button', { name: 'Reset to defaults' })).toBeDisabled();
  expect(await chartTuning(page)).toEqual(DEFAULTS);

  await button(page).click();
  await expect(popup(page)).toHaveCount(0);
  await openPopup(page);
  await popup(page).getByRole('button', { name: 'Close' }).click();
  await expect(popup(page)).toHaveCount(0);
  await openPopup(page);
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
  await expect(button(page)).toBeFocused();

  // With the interval menu open too, Escape closes the menu first.
  await openPopup(page);
  await menu.click();
  await expect(page.getByRole('region', { name: 'Interval menu' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Interval menu' })).toHaveCount(0);
  await expect(popup(page)).toBeVisible();
});

test('the chart stays in use while it is open, each gesture lighting its setting', async ({
  page,
}) => {
  const state = await openChart(page);
  await openPopup(page);
  const lit = async () =>
    popup(page)
      .locator('[data-lit]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-setting')));

  await dispatchWheel(page, CLEAR.x, CLEAR.y, [{ deltaY: -100 }]);
  const zoomed = await settled(page);
  expect(range(zoomed)).not.toEqual(range(state));
  expect(await lit()).toEqual(['zoomStep']);
  await dispatchWheel(page, CLEAR.x, CLEAR.y, [{ deltaY: -100, ctrlKey: true }]);
  expect(await lit()).toEqual(['pinchStep']);
  await dispatchWheel(page, CLEAR.x, CLEAR.y, [{ deltaX: 60 }]);
  expect(await lit()).toEqual(['panFactor']);
  await dispatchWheel(page, priceAxisX(state), 300, [{ deltaY: -100 }]);
  expect(await lit()).toEqual(['priceStep']);
  await expect.poll(lit, { timeout: 3_000 }).toEqual([]);

  // Pressing on the chart, as when dragging it, leaves the popup open.
  const pane = await page.getByRole('main', { name: 'Chart' }).boundingBox();
  await page.mouse.click((pane?.x ?? 0) + CLEAR.x, (pane?.y ?? 0) + CLEAR.y);
  await expect(popup(page)).toBeVisible();
});

test('price-scale speed, fixed point and direction apply at once', async ({ page }) => {
  const state = await openChart(page);
  await openPopup(page);
  const x = priceAxisX(state);

  await setSlider(page, 'Price scale', 'priceStep', 0.2);
  await dispatchWheel(page, x, 300, [{ deltaY: -100 }]);
  const faster = await settled(page);
  expect(priceSpan(faster)).toBeCloseTo(priceSpan(state) / 1.2, 9);

  // Pointer: the price under the pointer stays under it.
  await popup(page).getByRole('radio', { name: 'Pointer' }).check();
  await expect.poll(async () => (await chartTuning(page)).priceAnchor).toBe('pointer');
  const grabbed = await chartCall<number>(page, 'yToPrice', 250);
  await dispatchWheel(page, x, 250, [{ deltaY: -100 }]);
  const pointer = await settled(page);
  expect(priceSpan(pointer)).toBeCloseTo(priceSpan(faster) / 1.2, 9);
  expect(await chartCall<number>(page, 'priceToY', grabbed)).toBeCloseTo(250, 6);

  // Last price: the latest close stays put wherever the pointer is.
  await popup(page).getByRole('radio', { name: 'Last price' }).check();
  await expect.poll(async () => (await chartTuning(page)).priceAnchor).toBe('lastPrice');
  const lastY = await chartCall<number>(page, 'priceToY', 1.2955);
  await dispatchWheel(page, x, 600, [{ deltaY: 100 }]);
  const last = await settled(page);
  expect(priceSpan(last)).toBeCloseTo(priceSpan(pointer) / 0.8, 9);
  expect(await chartCall<number>(page, 'priceToY', 1.2955)).toBeCloseTo(lastY, 6);

  // Reversed: a wheel step up now squeezes.
  await popup(page).getByRole('checkbox', { name: 'Reverse' }).check();
  await expect.poll(async () => (await chartTuning(page)).priceReversed).toBe(true);
  await dispatchWheel(page, x, 300, [{ deltaY: -100 }]);
  const reversed = await settled(page);
  expect(priceSpan(reversed)).toBeCloseTo(priceSpan(last) / 0.8, 9);
  expect(reversed.logicalRange).toEqual(state.logicalRange);
});

test('zoom, pinch and scroll speeds apply at once', async ({ page }) => {
  await openChart(page);
  await openPopup(page);

  await setSlider(page, 'Zoom', 'zoomStep', 0.2);
  await dispatchWheel(page, CLEAR.x, CLEAR.y, [{ deltaY: -100 }]);
  const zoomed = await settled(page);
  expect(spacingOf(range(zoomed), zoomed.width)).toBeCloseTo(6 * 1.2, 3);

  await setSlider(page, 'Pinch zoom', 'pinchStep', 0.05);
  await dispatchWheel(page, CLEAR.x, CLEAR.y, [{ deltaY: -100, ctrlKey: true }]);
  const pinched = await settled(page);
  expect(spacingOf(range(pinched), pinched.width)).toBeCloseTo(6 * 1.2 * 1.05, 3);

  await setSlider(page, 'Scroll', 'panFactor', 1.6);
  await dispatchWheel(page, CLEAR.x, CLEAR.y, [{ deltaX: 60 }]);
  const panned = await settled(page);
  const spacing = spacingOf(range(pinched), pinched.width);
  expect(range(panned).to - range(pinched).to).toBeCloseTo((60 * 1.6) / spacing, 3);
});

test('settings stay for every visit, the button shows they changed, Reset undoes them', async ({
  page,
}) => {
  await openChart(page);
  await expect(button(page)).not.toHaveAttribute('data-changed');
  await openPopup(page);
  await setSlider(page, 'Price scale', 'priceStep', 0.3);
  await popup(page).getByRole('radio', { name: 'Pointer' }).check();
  await expect(button(page)).toHaveAttribute('data-changed');

  // A new visit: applied without opening anything.
  await openChart(page);
  await expect
    .poll(() => chartTuning(page))
    .toEqual({ ...DEFAULTS, priceStep: 0.3, priceAnchor: 'pointer' });
  await expect(button(page)).toHaveAttribute('data-changed');
  await openPopup(page);
  await expect(slider(page, 'Price scale')).toHaveValue('0.3');
  await expect(popup(page).getByRole('radio', { name: 'Pointer' })).toBeChecked();

  await popup(page).getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(slider(page, 'Price scale')).toHaveValue('0.1');
  await expect.poll(() => chartTuning(page)).toEqual(DEFAULTS);
  await expect(button(page)).not.toHaveAttribute('data-changed');
  await openChart(page);
  await expect.poll(() => chartTuning(page)).toEqual(DEFAULTS);
});

test('values set in the old ?tune panel carry over', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem('tn.gestures') === null) {
      window.localStorage.setItem(
        'tn.dev.gestureTuning',
        JSON.stringify({ zoomStep: 0.25, priceReversed: true }),
      );
    }
  });
  await openChart(page);
  await expect
    .poll(() => chartTuning(page))
    .toEqual({ ...DEFAULTS, zoomStep: 0.25, priceReversed: true });
  expect(await page.evaluate(() => window.localStorage.getItem('tn.dev.gestureTuning'))).toBeNull();
});

test('Copy values puts the values on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openChart(page);
  await openPopup(page);
  await setSlider(page, 'Zoom', 'zoomStep', 0.15);
  await popup(page).getByRole('button', { name: 'Copy values' }).click();
  await expect(popup(page).getByRole('button', { name: 'Copied' })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(text)).toEqual({ ...DEFAULTS, zoomStep: 0.15 });
});
