import {
  type ChartController,
  type ChartIndicator,
  formatIndicatorValue,
  NO_VALUE,
} from '@tradingnerd/chart';
import { indicatorDefinition, type SymbolContext } from '@tradingnerd/indicators';
import { useLayoutEffect } from 'react';
import styles from './IndicatorLegend.module.css';
import { EyeCrossedIcon, EyeIcon, FoldIcon, GearIcon, TrashIcon } from './icons';

/** What a row's buttons do. */
export interface RowActions {
  onHide(id: string, hidden: boolean): void;
  onSettings(id: string): void;
  onRemove(id: string): void;
}

/** One row's value elements: a span per plot (null for a plot the legend doesn't show). */
interface RowValues {
  indicator: ChartIndicator;
  spans: (HTMLSpanElement | null)[];
}

/**
 * The legend rows' values, updated imperatively like the OHLC legend: on each cursor move and
 * live tick, every row shows its indicator's values on the bar the legend shows.
 */
export class LegendValues {
  chart: ChartController | null = null;
  /** Whether the chart's symbol has real volume: Volume shows "n/a" otherwise. */
  hasVolume = true;
  private readonly rows = new Map<string, RowValues>();
  private index: number | null = null;

  /** A row's value spans, as rendered; null when it goes. */
  register(id: string, row: RowValues | null): void {
    if (row) this.rows.set(id, row);
    else this.rows.delete(id);
  }

  /** Each row's values on bar `index`. */
  show(index: number): void {
    this.index = index;
    const { chart } = this;
    if (!chart) return;
    for (const { id, values, growing } of chart.indicatorValues(index)) {
      const row = this.rows.get(id);
      if (!row) continue;
      const { indicator, spans } = row;
      const definition = indicatorDefinition(indicator.kind);
      definition.plots.forEach((plot, p) => {
        const span = spans[p];
        if (!span) return;
        const style = indicator.settings.styles[plot.id];
        const noVolume = definition.kind === 'volume' && !this.hasVolume;
        const text = noVolume
          ? 'n/a'
          : formatIndicatorValue(values[p] ?? Number.NaN, definition.format);
        if (span.textContent !== text) span.textContent = text;
        // Columns colored by direction show their bar's color; lines their own.
        const color =
          plot.kind === 'columns' && !growing
            ? (style?.fallingColor ?? style?.color)
            : style?.color;
        if (color && span.style.color !== color) span.style.color = color;
      });
    }
  }

  /** Shows the last bar shown again, e.g. after rows changed. */
  refresh(): void {
    if (this.index !== null) this.show(this.index);
  }
}

/** The plots a row shows values for: the ones these inputs have and the style shows. */
function shownPlots(indicator: ChartIndicator): boolean[] {
  const definition = indicatorDefinition(indicator.kind);
  const { inputs, styles } = indicator.settings;
  return definition.plots.map(
    (plot) => (plot.shownWhen?.(inputs) ?? true) && styles[plot.id]?.visible === true,
  );
}

/**
 * One indicator's legend row, as TradingView's (docs/reference/01-chart-layout.png): its title
 * ("RSI 14 close", "Vol · XRP"), its values in their plots' colors, and on hover its Hide,
 * Settings and Remove buttons. A hidden indicator keeps its row: the title dimmed, no values,
 * and a crossed-out eye that shows it again. A double-click on the title opens its settings.
 */
export function IndicatorRow({
  indicator,
  symbol,
  values,
  actions,
}: {
  indicator: ChartIndicator;
  symbol: SymbolContext;
  values: LegendValues;
  actions: RowActions;
}) {
  const definition = indicatorDefinition(indicator.kind);
  const title = definition.title(indicator.settings.inputs, symbol);
  const shown = shownPlots(indicator);
  const spans: (HTMLSpanElement | null)[] = definition.plots.map(() => null);

  useLayoutEffect(() => {
    values.register(indicator.id, indicator.hidden ? null : { indicator, spans });
    values.refresh();
    return () => values.register(indicator.id, null);
  });

  return (
    <div
      className={styles.row}
      data-hidden={indicator.hidden || undefined}
      data-indicator={indicator.id}
    >
      <button
        type="button"
        className={styles.title}
        title={definition.name}
        onDoubleClick={() => actions.onSettings(indicator.id)}
      >
        {title}
      </button>
      {indicator.hidden ? (
        <button
          type="button"
          className={styles.hiddenEye}
          aria-label="Show"
          title="Show"
          onClick={() => actions.onHide(indicator.id, false)}
        >
          <EyeCrossedIcon />
        </button>
      ) : (
        definition.plots.map((plot, p) =>
          shown[p] ? (
            <span
              key={plot.id}
              ref={(element) => {
                spans[p] = element;
              }}
              className={styles.value}
              data-plot={plot.id}
            >
              {NO_VALUE}
            </span>
          ) : null,
        )
      )}
      <span className={styles.buttons}>
        {!indicator.hidden && (
          <button
            type="button"
            className={styles.button}
            aria-label="Hide"
            title="Hide"
            onClick={() => actions.onHide(indicator.id, true)}
          >
            <EyeIcon />
          </button>
        )}
        <button
          type="button"
          className={styles.button}
          aria-label="Settings"
          title="Settings"
          onClick={() => actions.onSettings(indicator.id)}
        >
          <GearIcon />
        </button>
        <button
          type="button"
          className={styles.button}
          aria-label="Remove"
          title="Remove"
          onClick={() => actions.onRemove(indicator.id)}
        >
          <TrashIcon />
        </button>
      </span>
    </div>
  );
}

/** The price pane's indicator rows, under Sell and Buy, and the arrow that folds them. */
export function PriceLegendRows({
  indicators,
  folded,
  onFold,
  ...row
}: {
  indicators: readonly ChartIndicator[];
  folded: boolean;
  onFold(folded: boolean): void;
  symbol: SymbolContext;
  values: LegendValues;
  actions: RowActions;
}) {
  if (indicators.length === 0) return null;
  return (
    <div className={styles.rows} data-field="indicators">
      {!folded &&
        indicators.map((indicator) => (
          <IndicatorRow key={indicator.id} indicator={indicator} {...row} />
        ))}
      <button
        type="button"
        className={styles.fold}
        aria-label={folded ? 'Show indicators legend' : 'Hide indicators legend'}
        aria-expanded={!folded}
        onClick={() => onFold(!folded)}
      >
        <FoldIcon folded={folded} />
      </button>
    </div>
  );
}

/** An indicator pane's place in the chart (ChartController.paneLayout). */
export interface PaneBox {
  top: number;
  height: number;
  indicator: string | null;
}

/** Each indicator pane's legend, at the pane's top-left. */
export function PaneLegends({
  panes,
  indicators,
  ...row
}: {
  panes: readonly PaneBox[];
  indicators: readonly ChartIndicator[];
  symbol: SymbolContext;
  values: LegendValues;
  actions: RowActions;
}) {
  return (
    <>
      {panes.map((pane) => {
        const indicator = indicators.find((item) => item.id === pane.indicator);
        if (!indicator) return null;
        return (
          <div
            key={indicator.id}
            className={styles.paneLegend}
            style={{ top: pane.top }}
            data-pane-legend={indicator.id}
          >
            <IndicatorRow indicator={indicator} {...row} />
          </div>
        );
      })}
    </>
  );
}
