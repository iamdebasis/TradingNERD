import { type ChartIndicator, type ChartScript, scriptDefaultInputs } from '@tradingnerd/chart';
import { isScriptId, MAX_SCRIPT_SOURCE, parseScriptOrigin } from '@tradingnerd/core';
import {
  DEFAULT_DISPLAY,
  defaultSettings,
  type IndicatorKind,
  type IndicatorSettings,
  type InputValue,
  indicatorDefinition,
  isIndicatorKind,
  type StyleValue,
  sanitizeSettings,
} from '@tradingnerd/indicators';
import { useSyncExternalStore } from 'react';
import { readJson, removeKey, writeJson } from '../lib/storage';
import { compiled, definitionOf } from './definitions';

/** Where the chart's indicators are kept in this browser, like Chart settings (§6.16). */
export const INDICATORS_KEY = 'tn.chart.indicators';
/** The indicators starred in the Indicators dialog. */
export const FAVORITES_KEY = 'tn.indicators.favorites';
/**
 * The stored shape's version: a stored value of another shape is set aside, not misread.
 * 2: Pine scripts on the chart (docs/SPEC.md §6.17); a version 1 list reads as it is.
 */
export const INDICATORS_VERSION = 2;

/**
 * A pane's height kept between a twentieth and twenty times the price pane's: dragging can't go
 * further (the library's 30 px minimum), so anything outside is a damaged entry.
 */
const STRETCH_RANGE = { min: 0.05, max: 20 } as const;

export interface ChartIndicators {
  /** The chart's indicators in the order added: the legend's order, and their panes'. */
  list: readonly ChartIndicator[];
  /** The legend's indicator rows folded away by its arrow. */
  folded: boolean;
}

const EMPTY: ChartIndicators = { list: [], folded: false };

/** A script instance's code and where it came from; null if malformed. */
function sanitizeScript(value: unknown): ChartScript | null {
  if (typeof value !== 'object' || value === null) return null;
  const { source, scriptId, from } = value as Record<string, unknown>;
  if (typeof source !== 'string' || source.length > MAX_SCRIPT_SOURCE) return null;
  const origin = parseScriptOrigin(from);
  if (origin === undefined) return null;
  return { source, scriptId: isScriptId(scriptId) ? scriptId : null, from: origin };
}

/**
 * Settings kept as they are, as far as they look like settings: for a script that doesn't
 * compile now, so nothing is lost before its code is fixed.
 */
function looseSettings(value: unknown): IndicatorSettings {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const inputs: Record<string, InputValue> = {};
  for (const [key, item] of Object.entries((raw.inputs as Record<string, unknown>) ?? {})) {
    if (typeof item === 'number' || typeof item === 'string' || typeof item === 'boolean') {
      inputs[key] = item;
    }
  }
  const styles: Record<string, StyleValue> = {};
  for (const [key, item] of Object.entries((raw.styles as Record<string, unknown>) ?? {})) {
    if (typeof item === 'object' && item !== null) styles[key] = item as StyleValue;
  }
  return { inputs, styles, display: { ...DEFAULT_DISPLAY } };
}

/** A script instance's settings, checked against its code as it compiles now. */
function scriptSettings(script: ChartScript, value: unknown): IndicatorSettings {
  if (!compiled(script.source).program) return looseSettings(value);
  const probe: ChartIndicator = {
    id: '',
    kind: 'script',
    script,
    settings: looseSettings(value),
    hidden: false,
  };
  return sanitizeSettings(definitionOf(probe), value);
}

function sanitizeIndicator(value: unknown, taken: Set<string>): ChartIndicator | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, kind, settings, hidden, paneStretch, script } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || taken.has(id)) return null;
  let indicator: ChartIndicator;
  if (kind === 'script') {
    const code = sanitizeScript(script);
    if (!code) return null;
    indicator = {
      id,
      kind,
      script: code,
      settings: scriptSettings(code, settings),
      hidden: hidden === true,
    };
  } else if (isIndicatorKind(kind)) {
    indicator = {
      id,
      kind,
      settings: sanitizeSettings(indicatorDefinition(kind), settings),
      hidden: hidden === true,
    };
  } else {
    return null;
  }
  taken.add(id);
  if (typeof paneStretch === 'number' && Number.isFinite(paneStretch)) {
    indicator.paneStretch = Math.min(STRETCH_RANGE.max, Math.max(STRETCH_RANGE.min, paneStretch));
  }
  return indicator;
}

/** The stored indicators, or none: unknown kinds, duplicates and damaged entries are left out. */
export function sanitizeIndicators(value: unknown): ChartIndicators {
  if (typeof value !== 'object' || value === null) return EMPTY;
  const raw = value as Record<string, unknown>;
  if ((raw.version !== 1 && raw.version !== INDICATORS_VERSION) || !Array.isArray(raw.list)) {
    return EMPTY;
  }
  const taken = new Set<string>();
  const list: ChartIndicator[] = [];
  for (const item of raw.list) {
    const indicator = sanitizeIndicator(item, taken);
    if (indicator) list.push(indicator);
  }
  return { list, folded: raw.folded === true };
}

/** A new instance's id: its kind and the next number free ("rsi-2", "script-1"). */
export function nextId(kind: IndicatorKind | 'script', list: readonly ChartIndicator[]): string {
  let n = 1;
  const ids = new Set(list.map((indicator) => indicator.id));
  while (ids.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

/**
 * The chart's indicators, kept in this browser. The chart, the legend and the dialogs share one
 * copy; a settings edit applies at once, and the settings dialog's Cancel puts the old one back.
 */
export class IndicatorStore {
  private value: ChartIndicators;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.value = sanitizeIndicators(readJson(INDICATORS_KEY));
  }

  get = (): ChartIndicators => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Adds an indicator with TradingView's defaults, after the others; returns its id. */
  add(kind: IndicatorKind): string {
    const id = nextId(kind, this.value.list);
    const indicator: ChartIndicator = {
      id,
      kind,
      settings: defaultSettings(indicatorDefinition(kind)),
      hidden: false,
    };
    this.commit({ ...this.value, list: [...this.value.list, indicator] });
    return id;
  }

  /**
   * Puts a script on the chart (the Pine Editor's Add to chart, or My scripts), after the
   * others, with its defaults; returns its id.
   */
  addScript(script: ChartScript): string {
    const id = nextId('script', this.value.list);
    const indicator: ChartIndicator = {
      id,
      kind: 'script',
      script,
      settings: scriptSettings(script, null),
      hidden: false,
    };
    this.commit({ ...this.value, list: [...this.value.list, indicator] });
    return id;
  }

  /**
   * New code for a script on the chart (Update on chart): its inputs and changed looks stay
   * where the new code still has them.
   */
  updateScript(id: string, change: Partial<ChartScript>): void {
    this.update(id, (indicator) => {
      if (indicator.kind !== 'script' || !indicator.script) return indicator;
      const script = { ...indicator.script, ...change };
      const inputs: Record<string, InputValue> = { ...indicator.settings.inputs };
      const before = compiled(indicator.script.source).program;
      if (before && script.source !== indicator.script.source) {
        // Inputs left at the old code's defaults take the new code's, as a script reloads with
        // its defaults; the ones changed in its settings stay.
        for (const [key, value] of Object.entries(scriptDefaultInputs(before))) {
          if (inputs[key] === value) delete inputs[key];
        }
      }
      return {
        ...indicator,
        script,
        settings: scriptSettings(script, { ...indicator.settings, inputs }),
      };
    });
  }

  remove(id: string): void {
    this.commit({ ...this.value, list: this.value.list.filter((item) => item.id !== id) });
  }

  setHidden(id: string, hidden: boolean): void {
    this.update(id, (indicator) => ({ ...indicator, hidden }));
  }

  setSettings(id: string, settings: IndicatorSettings): void {
    this.update(id, (indicator) => ({
      ...indicator,
      settings:
        indicator.kind === 'script' && indicator.script
          ? scriptSettings(indicator.script, settings)
          : sanitizeSettings(definitionOf(indicator), settings),
    }));
  }

  /** Each pane's height as a share of the price pane's, by indicator id, after a drag. */
  setPaneHeights(heights: Record<string, number>): void {
    let changed = false;
    const list = this.value.list.map((indicator) => {
      const share = heights[indicator.id];
      if (share === undefined || share === indicator.paneStretch) return indicator;
      changed = true;
      return { ...indicator, paneStretch: share };
    });
    if (changed) this.commit({ ...this.value, list });
  }

  setFolded(folded: boolean): void {
    if (folded !== this.value.folded) this.commit({ ...this.value, folded });
  }

  private update(id: string, change: (indicator: ChartIndicator) => ChartIndicator): void {
    let changed = false;
    const list = this.value.list.map((indicator) => {
      if (indicator.id !== id) return indicator;
      changed = true;
      return change(indicator);
    });
    if (changed) this.commit({ ...this.value, list });
  }

  private commit(next: ChartIndicators): void {
    this.value = sanitizeIndicators({ version: INDICATORS_VERSION, ...next });
    if (this.value.list.length === 0 && !this.value.folded) removeKey(INDICATORS_KEY);
    else writeJson(INDICATORS_KEY, { version: INDICATORS_VERSION, ...this.value });
    for (const listener of [...this.listeners]) listener();
  }
}

/** The indicators the app uses. */
export const indicatorStore = new IndicatorStore();

/** The chart's indicators; re-renders when they change. */
export function useIndicators(): ChartIndicators {
  return useSyncExternalStore(indicatorStore.subscribe, indicatorStore.get);
}

/** The starred indicators, in the order starred. */
export function sanitizeFavorites(value: unknown): readonly IndicatorKind[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (kind, i): kind is IndicatorKind => isIndicatorKind(kind) && value.indexOf(kind) === i,
  );
}

/** TradingView's ☆ in the Indicators dialog: the favorites list and the toolbar's ⌄ menu. */
export class FavoriteIndicators {
  private value: readonly IndicatorKind[];
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.value = sanitizeFavorites(readJson(FAVORITES_KEY));
  }

  get = (): readonly IndicatorKind[] => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  toggle(kind: IndicatorKind): void {
    this.value = this.value.includes(kind)
      ? this.value.filter((item) => item !== kind)
      : [...this.value, kind];
    if (this.value.length === 0) removeKey(FAVORITES_KEY);
    else writeJson(FAVORITES_KEY, this.value);
    for (const listener of [...this.listeners]) listener();
  }
}

export const favoriteIndicators = new FavoriteIndicators();

export function useFavoriteIndicators(): readonly IndicatorKind[] {
  return useSyncExternalStore(favoriteIndicators.subscribe, favoriteIndicators.get);
}
