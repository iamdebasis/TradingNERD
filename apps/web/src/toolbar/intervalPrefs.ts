import {
  compareIntervals,
  formatResolution,
  INTERVAL_SECTIONS,
  type IntervalSection,
  intervalSection,
  menuLabel,
  parseResolution,
  type Resolution,
  STANDARD_INTERVALS,
  toolbarLabel,
} from '@tradingnerd/core';

/** The interval choices a user keeps: toolbar favorites, added intervals, collapsed sections. */
export interface IntervalPrefs {
  /** Toolbar favorites in TradingView notation, shortest first. */
  favorites: string[];
  /** Intervals added with "Add custom interval…", shortest first. */
  custom: string[];
  /** Menu sections the user folded away. */
  collapsed: IntervalSection[];
}

/**
 * The user's own TradingView setup (docs/reference/02-toolbar.png). Its menu has no 8- or
 * 12-hour entry, so those two favorites are custom intervals there too.
 */
export const DEFAULT_PREFS: IntervalPrefs = {
  favorites: ['1', '5', '15', '60', '120', '240', '480', '720', '1D', '1W', '1M', '6M', '12M'],
  custom: ['480', '720'],
  collapsed: [],
};

const SECTION_TITLES: Record<IntervalSection, string> = {
  ticks: 'Ticks',
  seconds: 'Seconds',
  minutes: 'Minutes',
  hours: 'Hours',
  days: 'Days',
};

function parse(text: string): Resolution | null {
  return parseResolution(text);
}

/** Canonical, de-duplicated, valid intervals, shortest first. */
function normalize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const parsed = new Map<string, Resolution>();
  for (const item of list) {
    const resolution = typeof item === 'string' ? parse(item) : null;
    if (resolution) parsed.set(formatResolution(resolution), resolution);
  }
  return [...parsed.entries()].sort(([, a], [, b]) => compareIntervals(a, b)).map(([text]) => text);
}

/** Prefs from anything (e.g. stored JSON); missing or malformed parts fall back to defaults. */
export function sanitizePrefs(input: unknown): IntervalPrefs {
  const source =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const standard = new Set(STANDARD_INTERVALS);
  return {
    favorites: Array.isArray(source.favorites)
      ? normalize(source.favorites)
      : [...DEFAULT_PREFS.favorites],
    custom: Array.isArray(source.custom)
      ? normalize(source.custom).filter((text) => !standard.has(text))
      : [...DEFAULT_PREFS.custom],
    collapsed: Array.isArray(source.collapsed)
      ? INTERVAL_SECTIONS.filter((section) => (source.collapsed as unknown[]).includes(section))
      : [],
  };
}

export function isFavorite(prefs: IntervalPrefs, interval: string): boolean {
  return prefs.favorites.includes(interval);
}

export function toggleFavorite(prefs: IntervalPrefs, interval: string): IntervalPrefs {
  const favorites = isFavorite(prefs, interval)
    ? prefs.favorites.filter((text) => text !== interval)
    : normalize([...prefs.favorites, interval]);
  return { ...prefs, favorites };
}

/** Adds an interval to its menu section; standard ones are always there already. */
export function addCustom(prefs: IntervalPrefs, interval: string): IntervalPrefs {
  if (STANDARD_INTERVALS.includes(interval) || prefs.custom.includes(interval)) return prefs;
  return { ...prefs, custom: normalize([...prefs.custom, interval]) };
}

/** Removes an added interval from the menu, and from the favorites with it. */
export function removeCustom(prefs: IntervalPrefs, interval: string): IntervalPrefs {
  return {
    ...prefs,
    custom: prefs.custom.filter((text) => text !== interval),
    favorites: prefs.favorites.filter((text) => text !== interval),
  };
}

export function toggleSection(prefs: IntervalPrefs, section: IntervalSection): IntervalPrefs {
  const collapsed = prefs.collapsed.includes(section)
    ? prefs.collapsed.filter((name) => name !== section)
    : INTERVAL_SECTIONS.filter((name) => name === section || prefs.collapsed.includes(name));
  return { ...prefs, collapsed };
}

export interface MenuItem {
  interval: string;
  /** "5 minutes" */
  label: string;
  favorite: boolean;
  /** Added by the user, so it can be removed. */
  custom: boolean;
}

export interface MenuSection {
  section: IntervalSection;
  title: string;
  collapsed: boolean;
  items: MenuItem[];
}

/** The interval menu: standard and added intervals, grouped into sections, shortest first. */
export function menuSections(prefs: IntervalPrefs): MenuSection[] {
  const all = normalize([...STANDARD_INTERVALS, ...prefs.custom]);
  return INTERVAL_SECTIONS.map((section) => ({
    section,
    title: SECTION_TITLES[section],
    collapsed: prefs.collapsed.includes(section),
    items: all
      .map((interval) => ({ interval, resolution: parse(interval) as Resolution }))
      .filter(({ resolution }) => intervalSection(resolution) === section)
      .map(({ interval, resolution }) => ({
        interval,
        label: menuLabel(resolution),
        favorite: isFavorite(prefs, interval),
        custom: prefs.custom.includes(interval),
      })),
  })).filter(({ items }) => items.length > 0);
}

export interface ToolbarButton {
  interval: string;
  /** "15m", "4h", "D" */
  label: string;
  active: boolean;
}

/** The toolbar's interval buttons: the favorites, plus the current interval when it isn't one. */
export function toolbarButtons(prefs: IntervalPrefs, current: string): ToolbarButton[] {
  return normalize([...prefs.favorites, current]).map((interval) => ({
    interval,
    label: toolbarLabel(parse(interval) as Resolution),
    active: interval === current,
  }));
}
