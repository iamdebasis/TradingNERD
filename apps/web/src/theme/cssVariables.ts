import type { Theme } from './tokens';

const toKebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Flattens a theme into CSS custom properties, e.g. color.textSecondary → --color-text-secondary. */
export function themeToCssVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {
    '--font-family': theme.font.family,
    '--font-size-ui': `${theme.font.sizeUi}px`,
    '--font-size-axis': `${theme.font.sizeAxis}px`,
  };
  for (const [name, value] of Object.entries(theme.color)) {
    vars[`--color-${toKebab(name)}`] = value;
  }
  for (const [name, value] of Object.entries(theme.size)) {
    vars[`--size-${toKebab(name)}`] = `${value}px`;
  }
  return vars;
}

/** Writes the theme's CSS variables onto an element (the document root at startup). */
export function applyTheme(target: HTMLElement, theme: Theme): void {
  for (const [name, value] of Object.entries(themeToCssVariables(theme))) {
    target.style.setProperty(name, value);
  }
}
