import {
  type Drawing,
  displayName,
  parseResolution,
  parseSymbolId,
  resolutionLabel,
  symbolName,
  type TreePlace,
} from '@tradingnerd/core';

/**
 * The Object tree's rows (docs/SPEC.md §5.27, D3c), in paint order with the top row at the back,
 * as TradingView lists them (its own GIF, measured: dragging the symbol's row below an SMA's put
 * the candles over the SMA line; §4.27). Each pane's drawings sent under its series come first,
 * then its series (the symbol's bars and the indicators drawn on the price pane, or an
 * indicator's own plots), then the drawings over them; the price pane first, then each
 * indicator's pane. A drawing is drawn under or over every series of its pane (D3a's layers), so
 * none can sit between two series rows.
 */

export type TreeRow =
  | { kind: 'symbol'; key: string; label: string; pane: null }
  | {
      kind: 'indicator';
      key: string;
      id: string;
      label: string;
      hidden: boolean;
      /** Null for one drawn on the price pane, else its own pane's key: its id. */
      pane: string | null;
    }
  | {
      kind: 'drawing';
      key: string;
      id: string;
      drawing: Drawing;
      label: string;
      pane: string | null;
    };

/** An indicator as the tree shows it. */
export interface TreeIndicator {
  id: string;
  label: string;
  hidden: boolean;
  /** Drawn on the price pane (Volume, a moving average), not in a pane of its own. */
  overlay: boolean;
}

export function treeRows(
  drawings: readonly Drawing[],
  indicators: readonly TreeIndicator[],
  symbolLabel: string,
): TreeRow[] {
  const drawingRows = (pane: string | null, below: boolean): TreeRow[] =>
    drawings
      .filter((drawing) => drawing.pane === pane && drawing.below === below)
      .map((drawing) => ({
        kind: 'drawing',
        key: `d:${drawing.id}`,
        id: drawing.id,
        drawing,
        label: displayName(drawing),
        pane,
      }));
  const indicatorRow = (indicator: TreeIndicator): TreeRow => ({
    kind: 'indicator',
    key: `i:${indicator.id}`,
    id: indicator.id,
    label: indicator.label,
    hidden: indicator.hidden,
    pane: indicator.overlay ? null : indicator.id,
  });
  const rows: TreeRow[] = [
    ...drawingRows(null, true),
    { kind: 'symbol', key: 'symbol', label: symbolLabel, pane: null },
    ...indicators.filter((indicator) => indicator.overlay).map(indicatorRow),
    ...drawingRows(null, false),
  ];
  for (const indicator of indicators.filter((item) => !item.overlay)) {
    rows.push(...drawingRows(indicator.id, true), indicatorRow(indicator));
    rows.push(...drawingRows(indicator.id, false));
  }
  return rows;
}

const isSeries = (row: TreeRow | undefined): boolean =>
  row !== undefined && (row.kind === 'symbol' || row.kind === 'indicator');

/**
 * Where drawings of a pane dragged to the gap before row `gap` (the rows' length for after the
 * last) would go, or null where they can't: another pane's rows, or between two series rows.
 */
export function dropPlace(
  rows: readonly TreeRow[],
  gap: number,
  pane: string | null,
): TreePlace | null {
  const prev = rows[gap - 1];
  const next = rows[gap];
  const ofPane = (row: TreeRow | undefined) => row !== undefined && row.pane === pane;
  if (!ofPane(prev) && !ofPane(next)) return null;
  // Just behind the drawing under the gap.
  if (next?.kind === 'drawing' && next.pane === pane) {
    return { pane, below: next.drawing.below, before: next.id };
  }
  // At the front of the layer of the drawing over the gap.
  if (prev?.kind === 'drawing' && prev.pane === pane) {
    return { pane, below: prev.drawing.below, before: null };
  }
  // Over the pane's series rows, its layer under them empty; or under them, the layer over empty.
  if (ofPane(next) && isSeries(next) && !(ofPane(prev) && isSeries(prev))) {
    return { pane, below: true, before: null };
  }
  if (ofPane(prev) && isSeries(prev) && !(ofPane(next) && isSeries(next))) {
    return { pane, below: false, before: null };
  }
  return null;
}

/**
 * The symbol's row, as TradingView writes it: "AAPL · NASDAQ, 1D" (its Help Center images); a
 * formula's without an exchange.
 */
export function treeSymbolLabel(symbol: string, interval: string): string {
  const parsed = parseResolution(interval);
  const label = parsed ? resolutionLabel(parsed) : interval;
  const exchange = parseSymbolId(symbol)?.exchange;
  return exchange
    ? `${symbolName(symbol)} · ${exchange}, ${label}`
    : `${symbolName(symbol)}, ${label}`;
}
