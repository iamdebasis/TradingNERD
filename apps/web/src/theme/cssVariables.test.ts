import { describe, expect, it, vi } from 'vitest';
import { applyTheme, themeToCssVariables } from './cssVariables';
import { darkTheme } from './tokens';

describe('darkTheme', () => {
  it('keeps the colors measured from the reference screenshots', () => {
    expect(darkTheme.color).toEqual({
      bg: '#0F0F0F',
      gutter: '#2E2E2E',
      grid: '#1C1C1C',
      chip: '#3D3D3D',
      separator: '#4A4A4A',
      popup: '#1F1F1F',
      selection: '#132E61',
      up: '#089981',
      down: '#F23645',
      upText: '#22AB94',
      unavailable: '#F7525F',
      avatarText: '#636363',
      accent: '#2962FF',
      crosshair: '#9C9C9C',
      labelText: '#FFFFFF',
      text: '#DBDBDB',
      textSecondary: '#8C8C8C',
      axisText: '#B8B8B8',
    });
  });

  it('keeps the measured layout sizes', () => {
    expect(darkTheme.size).toMatchObject({ toolbarHeight: 38, gutter: 4, rowHeight: 30 });
  });
});

describe('themeToCssVariables', () => {
  const vars = themeToCssVariables(darkTheme);

  it('maps colors to kebab-case variables', () => {
    expect(vars['--color-bg']).toBe('#0F0F0F');
    expect(vars['--color-text-secondary']).toBe('#8C8C8C');
    expect(vars['--color-axis-text']).toBe('#B8B8B8');
  });

  it('adds px units to sizes and fonts', () => {
    expect(vars['--size-toolbar-height']).toBe('38px');
    expect(vars['--size-panel-radius']).toBe(`${darkTheme.size.panelRadius}px`);
    expect(vars['--font-size-ui']).toBe('14px');
    expect(vars['--font-size-axis']).toBe('12px');
  });

  it('emits one variable per token', () => {
    const tokenCount = Object.keys(darkTheme.color).length + Object.keys(darkTheme.size).length + 3;
    expect(Object.keys(vars)).toHaveLength(tokenCount);
  });
});

describe('applyTheme', () => {
  it('writes every variable onto the target element', () => {
    const setProperty = vi.fn();
    applyTheme({ style: { setProperty } } as unknown as HTMLElement, darkTheme);
    expect(setProperty).toHaveBeenCalledWith('--color-gutter', '#2E2E2E');
    expect(setProperty).toHaveBeenCalledTimes(Object.keys(themeToCssVariables(darkTheme)).length);
  });
});
