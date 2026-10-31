import type { Locator, Page } from '@playwright/test';
import { chartState, expect, openChart, test } from './fixtures';

const toolbar = (page: Page) => page.getByRole('banner');
const chart = (page: Page) => page.getByRole('main', { name: 'Chart' });
const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const splitter = (page: Page) => page.getByRole('separator', { name: 'Resize watchlist' });

/** The window (playwright.config.ts): the reference's 1,634 px plus the right toolbar's 48. */
const WINDOW = 1634 + 48;
const RIGHT_TOOLBAR = 48;

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element is not visible');
  return box;
}

const widthOf = async (locator: Locator) => (await boxOf(locator)).width;

/** Drags the splitter horizontally by `dx` CSS px (negative = left = wider watchlist). */
async function dragSplitter(page: Page, dx: number) {
  const box = await boxOf(splitter(page));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await openChart(page);
});

test('layout geometry matches the reference screenshot', async ({ page }) => {
  // The reference's 1,634 × 1000 (docs/SPEC.md §7.2), the right toolbar beside it.
  expect(await boxOf(toolbar(page))).toEqual({ x: 0, y: 0, width: WINDOW, height: 38 });
  expect(await boxOf(chart(page))).toEqual({ x: 4, y: 42, width: 1307, height: 954 });
  expect(await boxOf(splitter(page))).toEqual({ x: 1311, y: 42, width: 4, height: 954 });
  expect(await boxOf(watchlist(page))).toEqual({ x: 1315, y: 42, width: 315, height: 954 });
});

test('surfaces use the measured colors and corner radius', async ({ page }) => {
  const look = (locator: Locator) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, radius: style.borderRadius };
    });
  const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  expect(bodyBackground).toBe('rgb(46, 46, 46)');
  expect((await look(toolbar(page))).background).toBe('rgb(15, 15, 15)');
  expect(await look(chart(page))).toEqual({ background: 'rgb(15, 15, 15)', radius: '3.5px' });
  expect(await look(watchlist(page))).toEqual({ background: 'rgb(15, 15, 15)', radius: '3.5px' });
});

test('dragging the splitter resizes the watchlist, the chart follows, and it is remembered', async ({
  page,
}) => {
  await dragSplitter(page, -100);
  expect(await widthOf(watchlist(page))).toBe(415);
  expect(await widthOf(chart(page))).toBe(1207);
  // The chart canvas resizes with its panel (pane + 72 px price axis + 1 px).
  await expect.poll(async () => (await chartState(page)).paneWidth).toBe(1207 - 73);

  await page.reload();
  expect(await widthOf(watchlist(page))).toBe(415);
});

test('the splitter stops at the minimum and maximum widths', async ({ page }) => {
  await dragSplitter(page, 2000);
  expect(await widthOf(watchlist(page))).toBe(240);

  await dragSplitter(page, -3000);
  // Window − right toolbar − workspace padding − splitter − minimum chart width.
  expect(await widthOf(watchlist(page))).toBe(WINDOW - RIGHT_TOOLBAR - 2 * 4 - 4 - 320);
  expect(await widthOf(chart(page))).toBe(320);
});

test('arrow keys resize the watchlist without scrolling the chart', async ({ page }) => {
  const before = await chartState(page);
  await splitter(page).focus();
  await page.keyboard.press('ArrowLeft');
  expect(await widthOf(watchlist(page))).toBe(331);
  await page.keyboard.press('Shift+ArrowRight');
  expect(await widthOf(watchlist(page))).toBe(267);
  await expect(splitter(page)).toHaveAttribute('aria-valuenow', '267');
  expect((await chartState(page)).scrollPosition).toBeCloseTo(before.scrollPosition, 6);
});

test('a narrow window squeezes the watchlist without forgetting its width', async ({ page }) => {
  await dragSplitter(page, -485);
  expect(await widthOf(watchlist(page))).toBe(800);

  await page.setViewportSize({ width: 1000, height: 1000 });
  await expect.poll(() => widthOf(watchlist(page))).toBe(1000 - RIGHT_TOOLBAR - 2 * 4 - 4 - 320);

  await page.setViewportSize({ width: WINDOW, height: 1000 });
  await expect.poll(() => widthOf(watchlist(page))).toBe(800);
});

test('reports its connection to the gateway', async ({ page }) => {
  await expect(page.locator('[data-gateway-status]')).toHaveAttribute(
    'data-gateway-status',
    'connected',
  );
});

test('stays free of console errors through hovering and resizing', async ({ page }) => {
  // The consoleGuard fixture fails this test on any console error or warning.
  await page.mouse.move(600, 400);
  await page.mouse.move(900, 500, { steps: 10 });
  await dragSplitter(page, -50);
  await page.mouse.move(700, 300, { steps: 5 });
});
