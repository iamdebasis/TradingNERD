/**
 * Design tokens for TradingView's dark theme, measured from the docs/reference/ screenshots
 * (Display P3 converted to sRGB). docs/SPEC.md §7 explains each one.
 */
export interface Theme {
  color: {
    /** Toolbar, chart and panel surfaces. */
    bg: string;
    /** Gaps between panels and 1 px row separators. */
    gutter: string;
    grid: string;
    /** Active interval, symbol pill, crosshair labels. */
    chip: string;
    /** Toolbar separators and menu dividers. */
    separator: string;
    /** Menus and dialogs. */
    popup: string;
    /** Selected watchlist row. */
    selection: string;
    up: string;
    down: string;
    /** Buy button, focus rings, matched search text. */
    accent: string;
    crosshair: string;
    /** Text on colored price-axis labels. */
    labelText: string;
    text: string;
    textSecondary: string;
    axisText: string;
  };
  font: {
    family: string;
    /** UI text size in px. */
    sizeUi: number;
    /** Chart axis text size in px. */
    sizeAxis: number;
  };
  /** Lengths in CSS px. */
  size: {
    toolbarHeight: number;
    gutter: number;
    panelRadius: number;
    rowHeight: number;
  };
}

export const darkTheme: Theme = {
  color: {
    bg: '#0F0F0F',
    gutter: '#2E2E2E',
    grid: '#1C1C1C',
    chip: '#3D3D3D',
    separator: '#4A4A4A',
    popup: '#1F1F1F',
    selection: '#132E61',
    up: '#089981',
    down: '#F23645',
    accent: '#2962FF',
    crosshair: '#9C9C9C',
    labelText: '#FFFFFF',
    text: '#DBDBDB',
    textSecondary: '#8C8C8C',
    axisText: '#B8B8B8',
  },
  font: {
    family: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
    sizeUi: 14,
    sizeAxis: 12,
  },
  size: {
    toolbarHeight: 38,
    gutter: 4,
    /** Best pixel match to the reference corners (tests/e2e/reference.spec.ts). */
    panelRadius: 3.5,
    rowHeight: 30,
  },
};
