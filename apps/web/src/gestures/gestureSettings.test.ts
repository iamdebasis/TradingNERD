import { DEFAULT_GESTURE_TUNING, type TuningNumber } from '@tradingnerd/chart';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GESTURES_KEY, GestureSettings, isChanged, OLD_TUNING_KEY } from './gestureSettings';

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

const saved = () => JSON.parse(stored.get(GESTURES_KEY) ?? 'null');

describe('gesture settings', () => {
  it('start at the defaults, and keep only what was changed', () => {
    const settings = new GestureSettings();
    expect(settings.get()).toEqual(DEFAULT_GESTURE_TUNING);
    expect(isChanged(settings.get())).toBe(false);

    settings.set({ zoomStep: 0.2, priceAnchor: 'pointer' });
    expect(saved()).toEqual({ ...DEFAULT_GESTURE_TUNING, zoomStep: 0.2, priceAnchor: 'pointer' });
    expect(new GestureSettings().get()).toEqual(saved()); // back after a reload

    // Set back by hand: nothing differs, so nothing is kept and better defaults would apply.
    settings.set({ zoomStep: DEFAULT_GESTURE_TUNING.zoomStep, priceAnchor: 'center' });
    expect(stored.has(GESTURES_KEY)).toBe(false);
  });

  it('reset to the defaults', () => {
    const settings = new GestureSettings();
    settings.set({ panFactor: 1.6, priceReversed: true });
    expect(isChanged(settings.get())).toBe(true);
    settings.reset();
    expect(settings.get()).toEqual(DEFAULT_GESTURE_TUNING);
    expect(stored.has(GESTURES_KEY)).toBe(false);
  });

  it('keep values in range, whatever was stored', () => {
    stored.set(GESTURES_KEY, JSON.stringify({ zoomStep: 9, pinchStep: 'fast', priceAnchor: 'x' }));
    const settings = new GestureSettings();
    expect(settings.get()).toEqual({ ...DEFAULT_GESTURE_TUNING, zoomStep: 0.5 });
    stored.set(GESTURES_KEY, 'not json');
    expect(new GestureSettings().get()).toEqual(DEFAULT_GESTURE_TUNING);
  });

  it("carry over the old dev panel's values, once", () => {
    stored.set(OLD_TUNING_KEY, JSON.stringify({ ...DEFAULT_GESTURE_TUNING, priceStep: 0.3 }));
    const settings = new GestureSettings();
    expect(settings.get().priceStep).toBe(0.3);
    expect(saved().priceStep).toBe(0.3);
    expect(stored.has(OLD_TUNING_KEY)).toBe(false);
  });

  it('tell listeners about changes and about gestures on the chart', () => {
    const settings = new GestureSettings();
    const changes: number[] = [];
    const gestures: TuningNumber[] = [];
    const stopChanges = settings.subscribe(() => changes.push(settings.get().zoomStep));
    const stopGestures = settings.onGesture((setting) => gestures.push(setting));
    settings.set({ zoomStep: 0.3 });
    settings.gestured('pinchStep');
    stopChanges();
    stopGestures();
    settings.set({ zoomStep: 0.4 });
    settings.gestured('panFactor');
    expect(changes).toEqual([0.3]);
    expect(gestures).toEqual(['pinchStep']);
  });
});
