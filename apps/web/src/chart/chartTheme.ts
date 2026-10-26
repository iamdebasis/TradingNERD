import type { ChartTheme } from '@tradingnerd/chart';
import type { Theme } from '../theme/tokens';

/** The chart's colors and fonts, taken from the app's design tokens. */
export function toChartTheme(theme: Theme): ChartTheme {
  return {
    background: theme.color.bg,
    grid: theme.color.grid,
    axisText: theme.color.axisText,
    crosshair: theme.color.crosshair,
    crosshairLabel: theme.color.chip,
    labelText: theme.color.labelText,
    up: theme.color.up,
    down: theme.color.down,
    // The gutter between panels, until TradingView's separator is measured (provisional, §11).
    paneSeparator: theme.color.gutter,
    fontFamily: theme.font.family,
    fontSize: theme.font.sizeAxis,
  };
}
