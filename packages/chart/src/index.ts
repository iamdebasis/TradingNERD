/**
 * Colors and fonts the chart needs. The app builds this from its design tokens and passes it in,
 * so this package never depends on app styles. The chart controller itself arrives in M1.
 */
export interface ChartTheme {
  background: string;
  grid: string;
  text: string;
  axisText: string;
  crosshair: string;
  crosshairLabel: string;
  up: string;
  down: string;
  fontFamily: string;
  fontSize: number;
}
