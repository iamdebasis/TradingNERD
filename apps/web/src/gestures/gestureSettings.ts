import {
  DEFAULT_GESTURE_TUNING,
  type GestureTuning,
  sanitizeTuning,
  type TuningNumber,
} from '@tradingnerd/chart';
import { useSyncExternalStore } from 'react';
import { readJson, removeKey, writeJson } from '../lib/storage';

/** Where the settings are kept in this browser. */
export const GESTURES_KEY = 'tn.gestures';
/** Where the old dev-only tuning panel (`?tune`) kept them: carried over once. */
export const OLD_TUNING_KEY = 'tn.dev.gestureTuning';

const NUMBERS: readonly TuningNumber[] = ['zoomStep', 'pinchStep', 'panFactor', 'priceStep'];

/** Whether any setting differs from the defaults. */
export function isChanged(tuning: GestureTuning): boolean {
  return (
    tuning.priceAnchor !== DEFAULT_GESTURE_TUNING.priceAnchor ||
    tuning.priceReversed !== DEFAULT_GESTURE_TUNING.priceReversed ||
    NUMBERS.some((key) => Math.abs(tuning[key] - DEFAULT_GESTURE_TUNING[key]) > 1e-9)
  );
}

/**
 * How the chart answers trackpad and wheel gestures (zoom, pinch, scroll and price-scale
 * speeds), as set in the top bar's Gestures popup. Kept in this browser; the chart and the
 * popup share one copy, and the popup hears which setting each gesture on the chart used.
 */
export class GestureSettings {
  private value: GestureTuning;
  private readonly listeners = new Set<() => void>();
  private readonly gestureListeners = new Set<(setting: TuningNumber) => void>();

  constructor() {
    this.value = load();
  }

  get = (): GestureTuning => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<GestureTuning>): void {
    this.value = sanitizeTuning(patch, this.value);
    save(this.value);
    this.emit();
  }

  reset(): void {
    this.value = { ...DEFAULT_GESTURE_TUNING };
    save(this.value);
    this.emit();
  }

  /** A gesture on the chart used `setting`. */
  gestured(setting: TuningNumber): void {
    for (const listener of [...this.gestureListeners]) listener(setting);
  }

  onGesture(listener: (setting: TuningNumber) => void): () => void {
    this.gestureListeners.add(listener);
    return () => this.gestureListeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function load(): GestureTuning {
  const saved = readJson(GESTURES_KEY);
  if (saved !== null) return sanitizeTuning(saved);
  const old = readJson(OLD_TUNING_KEY);
  if (old === null) return { ...DEFAULT_GESTURE_TUNING };
  const carried = sanitizeTuning(old);
  save(carried);
  removeKey(OLD_TUNING_KEY);
  return carried;
}

/** Only changed settings are kept, so improved defaults reach everyone else. */
function save(tuning: GestureTuning): void {
  if (isChanged(tuning)) writeJson(GESTURES_KEY, tuning);
  else removeKey(GESTURES_KEY);
}

/** The settings the app uses. */
export const gestureSettings = new GestureSettings();

/** The current settings; re-renders when they change. */
export function useGestureSettings(): GestureTuning {
  return useSyncExternalStore(gestureSettings.subscribe, gestureSettings.get);
}
