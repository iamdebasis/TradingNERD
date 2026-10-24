import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHART_SETTINGS_KEY,
  ChartSettingsStore,
  DEFAULT_CHART_SETTINGS,
  sanitizeChartSettings,
} from './chartSettings';
import { timezoneLabel, timezoneMenu } from './timezones';

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

const saved = () => JSON.parse(stored.get(CHART_SETTINGS_KEY) ?? 'null');

describe('chart settings', () => {
  it("start at TradingView's defaults, and keep only a change", () => {
    const settings = new ChartSettingsStore();
    expect(settings.get()).toEqual(DEFAULT_CHART_SETTINGS);
    expect(settings.get().timezone).toBe('exchange');

    settings.set({ session: 'extended', timezone: 'Europe/Berlin' });
    expect(saved()).toMatchObject({ session: 'extended', timezone: 'Europe/Berlin' });
    expect(new ChartSettingsStore().get()).toEqual(settings.get()); // back after a reload

    settings.replace(DEFAULT_CHART_SETTINGS);
    expect(stored.has(CHART_SETTINGS_KEY)).toBe(false);
  });

  it('tell listeners of a change, and only of a change', () => {
    const settings = new ChartSettingsStore();
    const heard = vi.fn();
    settings.subscribe(heard);
    settings.set({ session: 'regular' });
    expect(heard).not.toHaveBeenCalled();
    settings.set({ session: 'extended' });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('ignore anything off, keeping the current values', () => {
    const base = { ...DEFAULT_CHART_SETTINGS, session: 'extended' as const };
    expect(
      sanitizeChartSettings(
        {
          session: 'overnight',
          timezone: 'Mars/Olympus',
          preMarketBackground: { color: 'orange', opacity: 2 },
          postMarketBackground: null,
        },
        base,
      ),
    ).toEqual({
      ...base,
      preMarketBackground: { color: '#FF9800', opacity: 1 },
    });
    expect(sanitizeChartSettings('nonsense')).toEqual(DEFAULT_CHART_SETTINGS);
  });
});

describe('time zones', () => {
  const october = Date.parse('2026-10-19T12:00:00Z');
  const january = Date.parse('2026-01-19T12:00:00Z');

  it("are named as TradingView's menu names them, summer time included", () => {
    expect(timezoneLabel('America/New_York', october)).toBe('(UTC-4) New York');
    expect(timezoneLabel('America/New_York', january)).toBe('(UTC-5) New York');
    expect(timezoneLabel('Europe/Berlin', october)).toBe('(UTC+2) Berlin');
    expect(timezoneLabel('Asia/Kolkata', october)).toBe('(UTC+5:30) Kolkata');
    expect(timezoneLabel('America/Argentina/Buenos_Aires', october)).toBe('(UTC-3) Buenos Aires');
    expect(timezoneLabel('Europe/London', january)).toBe('(UTC) London');
    expect(timezoneLabel('Etc/UTC', october)).toBe('UTC');
  });

  it('list UTC first, then west to east', () => {
    const menu = timezoneMenu(october);
    expect(menu[0]).toEqual({ zone: 'Etc/UTC', label: 'UTC' });
    expect(menu[1]?.zone).toBe('Pacific/Honolulu');
    expect(menu.at(-1)?.zone).toBe('Pacific/Chatham');
    expect(menu).toHaveLength(98);
  });
});
