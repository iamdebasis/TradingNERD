import { describe, expect, it } from 'vitest';
import {
  addCustom,
  DEFAULT_PREFS,
  menuSections,
  removeCustom,
  sanitizePrefs,
  toggleFavorite,
  toggleSection,
  toolbarButtons,
} from './intervalPrefs';

describe('default interval prefs', () => {
  it("match the user's TradingView toolbar", () => {
    expect(toolbarButtons(DEFAULT_PREFS, '1D').map((button) => button.label)).toEqual([
      '1m',
      '5m',
      '15m',
      '1h',
      '2h',
      '4h',
      '8h',
      '12h',
      'D',
      'W',
      'M',
      '6M',
      '12M',
    ]);
  });

  it("lay out TradingView's menu, with 8 and 12 hours added under Hours", () => {
    const sections = menuSections(DEFAULT_PREFS);
    expect(sections.map(({ title, items }) => [title, items.map((item) => item.label)])).toEqual([
      ['Ticks', ['1 tick', '10 ticks', '100 ticks', '1000 ticks']],
      [
        'Seconds',
        ['1 second', '5 seconds', '10 seconds', '15 seconds', '30 seconds', '45 seconds'],
      ],
      [
        'Minutes',
        ['1 minute', '2 minutes', '3 minutes', '5 minutes', '10 minutes', '15 minutes'].concat([
          '30 minutes',
          '45 minutes',
        ]),
      ],
      ['Hours', ['1 hour', '2 hours', '3 hours', '4 hours', '8 hours', '12 hours']],
      ['Days', ['1 day', '1 week', '1 month', '3 months', '6 months', '12 months']],
    ]);
    const minutes = sections[2]?.items ?? [];
    expect(minutes.filter((item) => item.favorite).map((item) => item.interval)).toEqual([
      '1',
      '5',
      '15',
    ]);
    const hours = sections[3]?.items ?? [];
    expect(hours.filter((item) => item.custom).map((item) => item.interval)).toEqual([
      '480',
      '720',
    ]);
  });
});

describe('editing prefs', () => {
  it('toggles favorites, keeping them shortest first', () => {
    const added = toggleFavorite(DEFAULT_PREFS, '3');
    expect(added.favorites.slice(0, 4)).toEqual(['1', '3', '5', '15']);
    expect(toggleFavorite(added, '3')).toEqual(DEFAULT_PREFS);
  });

  it('adds custom intervals once, never standard ones, and removes them with their star', () => {
    const added = addCustom(DEFAULT_PREFS, '7');
    expect(added.custom).toEqual(['7', '480', '720']);
    expect(addCustom(added, '7')).toBe(added);
    expect(addCustom(DEFAULT_PREFS, '45')).toBe(DEFAULT_PREFS);

    const removed = removeCustom(DEFAULT_PREFS, '480');
    expect(removed.custom).toEqual(['720']);
    expect(removed.favorites).not.toContain('480');
  });

  it('folds sections, kept in menu order', () => {
    const folded = toggleSection(toggleSection(DEFAULT_PREFS, 'seconds'), 'ticks');
    expect(folded.collapsed).toEqual(['ticks', 'seconds']);
    expect(menuSections(folded).map((section) => section.collapsed)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(toggleSection(folded, 'ticks').collapsed).toEqual(['seconds']);
  });
});

describe('the toolbar', () => {
  it('marks the active interval', () => {
    const active = toolbarButtons(DEFAULT_PREFS, '15').filter((button) => button.active);
    expect(active.map((button) => button.label)).toEqual(['15m']);
  });

  it('shows the current interval among the favorites when it is not one', () => {
    const labels = toolbarButtons(DEFAULT_PREFS, '3').map((button) => button.label);
    expect(labels.slice(0, 4)).toEqual(['1m', '3m', '5m', '15m']);
    expect(toolbarButtons(DEFAULT_PREFS, '10T')[0]).toEqual({
      interval: '10T',
      label: '10T',
      active: true,
    });
  });
});

describe('sanitizePrefs', () => {
  it('falls back to the defaults for anything unusable', () => {
    for (const input of [null, 'x', 42, []]) expect(sanitizePrefs(input)).toEqual(DEFAULT_PREFS);
  });

  it('keeps valid entries, canonical and sorted, and drops the rest', () => {
    expect(
      sanitizePrefs({
        favorites: ['D', '60', 'nonsense', '60', 5, '1S'],
        custom: ['7', '45', 'x', '7'],
        collapsed: ['days', 'ticks', 'weeks'],
      }),
    ).toEqual({
      favorites: ['1S', '60', '1D'],
      custom: ['7'],
      collapsed: ['ticks', 'days'],
    });
  });

  it('keeps an emptied favorites list empty', () => {
    expect(sanitizePrefs({ favorites: [] }).favorites).toEqual([]);
  });
});
