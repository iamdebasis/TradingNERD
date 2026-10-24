import { isSessionHours, type SessionHours } from '@tradingnerd/core';
import { useSyncExternalStore } from 'react';
import { readJson, removeKey, writeJson } from '../lib/storage';
import { isSupportedTimezone } from './timezones';

/** Where the settings are kept in this browser. */
export const CHART_SETTINGS_KEY = 'tn.chart.settings';

/** A background fill: a color and how opaque it is (0–1). */
export interface Fill {
  /** "#RRGGBB" */
  color: string;
  opacity: number;
}

/** The chart's own settings, from TradingView's Chart settings → Symbol (docs/SPEC.md §5.8). */
export interface ChartSettings {
  /** Session: intraday bars of the regular session, or with pre- and post-market trading. */
  session: SessionHours;
  /** Pre/post market hours background, shown while extended hours are on. */
  preMarketBackground: Fill;
  postMarketBackground: Fill;
  /** Timezone: the exchange's own ("exchange"), or one TradingView offers (IANA). */
  timezone: string;
}

/**
 * TradingView's defaults: regular hours in the exchange's time zone, with orange and blue pre-
 * and post-market backgrounds at 92% transparency. The background colors were measured from a
 * Chart settings screenshot and are provisional (docs/SPEC.md §11).
 */
export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  session: 'regular',
  preMarketBackground: { color: '#FF9800', opacity: 0.08 },
  postMarketBackground: { color: '#2962FF', opacity: 0.08 },
  timezone: 'exchange',
};

const isColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);

function sanitizeFill(value: unknown, fallback: Fill): Fill {
  if (typeof value !== 'object' || value === null) return fallback;
  const { color, opacity } = value as Record<string, unknown>;
  return {
    color: isColor(color) ? color.toUpperCase() : fallback.color,
    opacity:
      typeof opacity === 'number' && Number.isFinite(opacity)
        ? Math.min(1, Math.max(0, opacity))
        : fallback.opacity,
  };
}

/** Settings from storage or an edit: anything off falls back to the current value. */
export function sanitizeChartSettings(
  value: unknown,
  base: ChartSettings = DEFAULT_CHART_SETTINGS,
): ChartSettings {
  if (typeof value !== 'object' || value === null) return { ...base };
  const v = value as Record<string, unknown>;
  return {
    session: isSessionHours(v.session) ? v.session : base.session,
    preMarketBackground: sanitizeFill(v.preMarketBackground, base.preMarketBackground),
    postMarketBackground: sanitizeFill(v.postMarketBackground, base.postMarketBackground),
    timezone:
      typeof v.timezone === 'string' &&
      (v.timezone === 'exchange' || isSupportedTimezone(v.timezone))
        ? v.timezone
        : base.timezone,
  };
}

const sameFill = (a: Fill, b: Fill) =>
  a.color === b.color && Math.abs(a.opacity - b.opacity) < 1e-9;

export function sameSettings(a: ChartSettings, b: ChartSettings): boolean {
  return (
    a.session === b.session &&
    a.timezone === b.timezone &&
    sameFill(a.preMarketBackground, b.preMarketBackground) &&
    sameFill(a.postMarketBackground, b.postMarketBackground)
  );
}

/**
 * The chart settings, kept in this browser like TradingView keeps a layout's. The chart and the
 * Chart settings dialog share one copy; edits apply at once, and the dialog's Cancel puts the
 * old ones back.
 */
export class ChartSettingsStore {
  private value: ChartSettings;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.value = sanitizeChartSettings(readJson(CHART_SETTINGS_KEY));
  }

  get = (): ChartSettings => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<ChartSettings>): void {
    this.replace({ ...this.value, ...patch });
  }

  replace(next: ChartSettings): void {
    const value = sanitizeChartSettings(next, this.value);
    if (sameSettings(value, this.value)) return;
    this.value = value;
    // Only changed settings are kept, so improved defaults reach everyone else.
    if (sameSettings(value, DEFAULT_CHART_SETTINGS)) removeKey(CHART_SETTINGS_KEY);
    else writeJson(CHART_SETTINGS_KEY, value);
    for (const listener of [...this.listeners]) listener();
  }
}

/** The settings the app uses. */
export const chartSettings = new ChartSettingsStore();

/** The current settings; re-renders when they change. */
export function useChartSettings(): ChartSettings {
  return useSyncExternalStore(chartSettings.subscribe, chartSettings.get);
}
