import {
  type Drawing,
  displayName,
  type GroupItem,
  parseResolution,
  parseSymbolId,
  resolutionLabel,
  symbolName,
  type TreeTarget,
} from '@tradingnerd/core';

/**
 * The Object tree's rows (docs/SPEC.md §5.27, D3c, D3c2), in paint order with the top row at the
 * back, as TradingView lists them (its own GIF, measured: dragging the symbol's row below an
 * SMA's put the candles over the SMA line; §4.27). Each pane's drawings sent under its series
 * come first, then its series (the symbol's bars and the indicators drawn on the price pane, or
 * an indicator's own plots), then the drawings over them; the price pane first, then each
 * indicator's pane. A drawing is drawn under or over every series of its pane (D3a's layers), so
 * none can sit between two series rows. A group's row comes before its drawings and the groups
 * inside it, each level indented (TradingView's nested groups, October 2026); a folded group's
 * are left out.
 */

export type TreeRow =
  | { kind: 'symbol'; key: string; label: string; pane: null; depth: 0 }
  | {
      kind: 'indicator';
      key: string;
      id: string;
      label: string;
      hidden: boolean;
      /** Null for one drawn on the price pane, else its own pane's key: its id. */
      pane: string | null;
      depth: 0;
    }
  | {
      kind: 'group';
      key: string;
      id: string;
      label: string;
      pane: string | null;
      /** Its layer: under the pane's series, or over them. */
      below: boolean;
      depth: number;
      /** The groups it's in and then itself, the outermost first: their ids. */
      path: readonly string[];
      folded: boolean;
      /** Its drawings at every level, in drawing order. */
      members: readonly Drawing[];
    }
  | {
      kind: 'drawing';
      key: string;
      id: string;
      drawing: Drawing;
      label: string;
      pane: string | null;
      depth: number;
      /** The groups it's in, the outermost first: their ids. */
      path: readonly string[];
    };

export type GroupRow = Extract<TreeRow, { kind: 'group' }>;
export type DrawingRow = Extract<TreeRow, { kind: 'drawing' }>;
/** A row that can be picked, dragged and dropped among: a drawing's or a group's. */
export type ItemRow = GroupRow | DrawingRow;

/** An indicator as the tree shows it. */
export interface TreeIndicator {
  id: string;
  label: string;
  hidden: boolean;
  /** Drawn on the price pane (Volume, a moving average), not in a pane of its own. */
  overlay: boolean;
}

/** A group's name as the tree writes it ("Group" for one a file left without a name). */
export const groupLabel = (name: string) => name || 'Group';

export const isItemRow = (row: TreeRow | undefined): row is ItemRow =>
  row !== undefined && (row.kind === 'drawing' || row.kind === 'group');

/** The item a row stands for. */
export const itemOf = (row: ItemRow): GroupItem => ({
  kind: row.kind === 'group' ? 'group' : 'drawing',
  id: row.id,
});

/** The group a row is directly in, or null. */
export const parentOfRow = (row: ItemRow): string | null =>
  (row.kind === 'group' ? row.path.at(-2) : row.path.at(-1)) ?? null;

/** A row's layer: under the pane's series, or over them. */
const layerOf = (row: ItemRow) => (row.kind === 'group' ? row.below : row.drawing.below);

export function treeRows(
  drawings: readonly Drawing[],
  indicators: readonly TreeIndicator[],
  symbolLabel: string,
  folded: ReadonlySet<string> = new Set(),
): TreeRow[] {
  const members = new Map<string, Drawing[]>();
  for (const drawing of drawings) {
    for (const group of drawing.groups) {
      const list = members.get(group.id);
      if (list) list.push(drawing);
      else members.set(group.id, [drawing]);
    }
  }
  const drawingRows = (pane: string | null, below: boolean): TreeRow[] => {
    const rows: TreeRow[] = [];
    // The groups open around the drawing before: a drawing's groups sit together (D3c2).
    let open: string[] = [];
    for (const drawing of drawings) {
      if (drawing.pane !== pane || drawing.below !== below) continue;
      const path = drawing.groups.map((group) => group.id);
      let same = 0;
      while (same < open.length && open[same] === path[same]) same++;
      open = open.slice(0, same);
      for (let depth = same; depth < drawing.groups.length; depth++) {
        const group = drawing.groups[depth];
        if (!group) break;
        open.push(group.id);
        if (open.slice(0, depth).some((id) => folded.has(id))) continue;
        rows.push({
          kind: 'group',
          key: `g:${group.id}`,
          id: group.id,
          label: groupLabel(group.name),
          pane,
          below,
          depth,
          path: open.slice(),
          folded: folded.has(group.id),
          members: members.get(group.id) ?? [],
        });
      }
      if (path.some((id) => folded.has(id))) continue;
      rows.push({
        kind: 'drawing',
        key: `d:${drawing.id}`,
        id: drawing.id,
        drawing,
        label: displayName(drawing),
        pane,
        depth: path.length,
        path,
      });
    }
    return rows;
  };
  const indicatorRow = (indicator: TreeIndicator): TreeRow => ({
    kind: 'indicator',
    key: `i:${indicator.id}`,
    id: indicator.id,
    label: indicator.label,
    hidden: indicator.hidden,
    pane: indicator.overlay ? null : indicator.id,
    depth: 0,
  });
  const rows: TreeRow[] = [
    ...drawingRows(null, true),
    { kind: 'symbol', key: 'symbol', label: symbolLabel, pane: null, depth: 0 },
    ...indicators.filter((indicator) => indicator.overlay).map(indicatorRow),
    ...drawingRows(null, false),
  ];
  for (const indicator of indicators.filter((item) => !item.overlay)) {
    rows.push(...drawingRows(indicator.id, true), indicatorRow(indicator));
    rows.push(...drawingRows(indicator.id, false));
  }
  return rows;
}

/** What's being dragged: its pane, and the items (with the groups among them) that move. */
export interface TreeDrag {
  pane: string | null;
  /** The items' keys, "d:" or "g:" and their ids. */
  items: ReadonlySet<string>;
  groups: ReadonlySet<string>;
}

/** A drop between rows: the line before row `gap`, indented to `depth`. */
export interface GapDrop {
  kind: 'gap';
  gap: number;
  depth: number;
  target: TreeTarget;
}

/** A drop onto a group's row: into it, first (TradingView: "directly below the header"). */
export interface HeaderDrop {
  kind: 'header';
  row: string;
  target: TreeTarget;
}

export type TreeDrop = GapDrop | HeaderDrop;

const isSeries = (row: TreeRow | undefined, pane: string | null) =>
  row !== undefined && (row.kind === 'symbol' || row.kind === 'indicator') && row.pane === pane;

/** True when a target's group is one being dragged or inside one, or its place is one of them. */
function intoItself(target: TreeTarget, path: readonly string[], drag: TreeDrag): boolean {
  if (path.some((id) => drag.groups.has(id))) return true;
  const { before } = target;
  return before !== null && drag.items.has(`${before.kind === 'group' ? 'g' : 'd'}:${before.id}`);
}

/**
 * Where items of a pane dragged to the gap before row `gap` (the rows' length for after the
 * last) would go, or null where they can't: another pane's rows, between two series rows, or
 * into what's dragged. After a group's last row the gap is ambiguous: `wanted`, the depth the
 * pointer is at, says how far in (inside the group, at its front, or out after it: ours,
 * provisional §11).
 */
export function gapDrop(
  rows: readonly TreeRow[],
  gap: number,
  wanted: number,
  drag: TreeDrag,
): GapDrop | null {
  const { pane } = drag;
  const prev = rows[gap - 1];
  const next = rows[gap];
  const movable = (row: TreeRow | undefined): row is ItemRow => isItemRow(row) && row.pane === pane;
  let drop: GapDrop | null = null;
  let path: readonly string[] = [];
  if (movable(prev)) {
    const low = movable(next) ? next.depth : 0;
    const high = prev.kind === 'group' && !prev.folded ? prev.depth + 1 : prev.depth;
    const depth = Math.max(low, Math.min(high, wanted));
    if (movable(next) && depth === next.depth) {
      path = next.kind === 'group' ? next.path.slice(0, -1) : next.path;
      drop = {
        kind: 'gap',
        gap,
        depth,
        target: { pane, below: layerOf(next), parent: parentOfRow(next), before: itemOf(next) },
      };
    } else {
      path = prev.path.slice(0, depth);
      drop = {
        kind: 'gap',
        gap,
        depth,
        target: { pane, below: layerOf(prev), parent: path.at(-1) ?? null, before: null },
      };
    }
  } else if (movable(next)) {
    path = next.kind === 'group' ? next.path.slice(0, -1) : next.path;
    drop = {
      kind: 'gap',
      gap,
      depth: next.depth,
      target: { pane, below: layerOf(next), parent: parentOfRow(next), before: itemOf(next) },
    };
  } else if (isSeries(next, pane) && !isSeries(prev, pane)) {
    // Over the pane's series rows, its layer under them empty.
    drop = {
      kind: 'gap',
      gap,
      depth: 0,
      target: { pane, below: true, parent: null, before: null },
    };
  } else if (isSeries(prev, pane) && !isSeries(next, pane)) {
    // Under them, the layer over them empty.
    drop = {
      kind: 'gap',
      gap,
      depth: 0,
      target: { pane, below: false, parent: null, before: null },
    };
  }
  return drop && !intoItself(drop.target, path, drag) ? drop : null;
}

/**
 * Items dropped onto a group's row go into it, first, directly below its row (TradingView's
 * Help Center, nested groups: "a drop onto a group's header puts it first inside"); a folded
 * group stays folded. Null for another pane's group, or one being dragged or inside one.
 */
export function headerDrop(row: GroupRow, drag: TreeDrag): HeaderDrop | null {
  if (row.pane !== drag.pane || row.path.some((id) => drag.groups.has(id))) return null;
  // Its first item (at the back) that isn't dragged: they go just behind it.
  let before: GroupItem | null = null;
  for (const drawing of row.members) {
    const inner = drawing.groups[row.depth + 1];
    const item: GroupItem = inner
      ? { kind: 'group', id: inner.id }
      : { kind: 'drawing', id: drawing.id };
    if (!drag.items.has(`${item.kind === 'group' ? 'g' : 'd'}:${item.id}`)) {
      before = item;
      break;
    }
  }
  return {
    kind: 'header',
    row: row.key,
    target: { pane: row.pane, below: row.below, parent: row.id, before },
  };
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
