/**
 * Colors and fonts the chart needs. The app builds this from its design tokens and passes it in,
 * so this package never depends on app styles.
 */
export interface ChartTheme {
  background: string;
  grid: string;
  /** Axis tick labels. */
  axisText: string;
  crosshair: string;
  /** Background of crosshair labels and the ⊕ box. */
  crosshairLabel: string;
  /** Text on colored labels (last price, crosshair). */
  labelText: string;
  up: string;
  down: string;
  fontFamily: string;
  /** Axis font size in px. */
  fontSize: number;
}
