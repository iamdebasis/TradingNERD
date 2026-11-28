import {
  type GroupItem,
  groupMembers,
  groupPath,
  itemLevels,
  normalizeGroups,
  parentOf,
  sameArrangement,
  topItems,
} from './drawingGroups.ts';
import { type Drawing, type DrawingGroup, MAX_GROUP_DEPTH } from './drawings.ts';

/**
 * Visual order (docs/SPEC.md §5.27, D3a, D3c2): a drawing's place among the others, as
 * TradingView's right-click menu sets it (Help Center, How can I change the visual order/layer
 * of indicators, drawings & candles?), in its submenu's order (its Help Center GIFs, November
 * 2024, and blog GIF, December 2021): Bring to front, Send to back, Bring forward, Send
 * backward. A symbol's drawings are listed in paint order, the last on top; those `below` the
 * chart's bars paint under them, in the same order. A group moves as one, and a drawing in a
 * group moves among the group's own items (the Charting Library's group moves).
 */
export const VISUAL_ORDER_MOVES = [
  'bring-to-front',
  'send-to-back',
  'bring-forward',
  'send-backward',
] as const;
export type VisualOrderMove = (typeof VISUAL_ORDER_MOVES)[number];

/** Their words in TradingView's submenu (its Help Center's GIF 43000660419-5, November 2024). */
export const VISUAL_ORDER_NAMES: Record<VisualOrderMove, string> = {
  'bring-to-front': 'Bring to front',
  'send-to-back': 'Send to back',
  'bring-forward': 'Bring forward',
  'send-backward': 'Send backward',
};

/** The chart's bars in the stack: the drawings under them before it, the rest after. */
const BARS = Symbol('bars');

/** A drawing, or a group's drawings, moving as one. */
interface Unit {
  members: Drawing[];
  picked: boolean;
  pane: string | null;
  below: boolean;
  /** A vertical line and a crossline cross every pane (the engine draws them there). */
  crosses: boolean;
}
type Token = Unit | typeof BARS;

const crosses = (drawing: Drawing) =>
  drawing.tool === 'vertical-line' || drawing.tool === 'cross-line';

/** What a unit stepping forward or backward can pass: the bars, and what it's drawn with. */
const meets = (token: Token, unit: Unit) =>
  token === BARS || token.pane === unit.pane || token.crosses || unit.crosses;

/**
 * The units of a run of drawings: each drawing directly at `depth`, and each group at that depth
 * (its drawings together, as the group rules keep them).
 */
function unitsOf(drawings: readonly Drawing[], depth: number, picked: Set<string>): Unit[] {
  const units: Unit[] = [];
  let last: string | null = null;
  for (const drawing of drawings) {
    const group = drawing.groups[depth];
    const key = group ? `g:${group.id}` : `d:${drawing.id}`;
    const unit = units.at(-1);
    if (unit && key === last && group) {
      unit.members.push(drawing);
      unit.crosses ||= crosses(drawing);
      continue;
    }
    last = key;
    units.push({
      members: [drawing],
      picked: picked.has(key),
      pane: drawing.pane,
      below: drawing.below,
      crosses: crosses(drawing),
    });
  }
  return units;
}

/** The tokens after a move of the picked ones (see reorderItems); `meet` says who steps past whom. */
function moved(tokens: readonly Token[], move: VisualOrderMove): Token[] {
  const picked = (token: Token | undefined): token is Unit =>
    token !== undefined && token !== BARS && token.picked;
  let next = tokens.slice();
  switch (move) {
    case 'bring-to-front':
      next = [...next.filter((token) => !picked(token)), ...next.filter(picked)];
      break;
    case 'send-to-back':
      next = [...next.filter(picked), ...next.filter((token) => !picked(token))];
      break;
    case 'bring-forward':
      // From the top down, each past the nearest one above it that it meets.
      for (let i = next.length - 2; i >= 0; i--) {
        const token = next[i];
        if (!picked(token)) continue;
        const j = next.findIndex((other, k) => k > i && !picked(other) && meets(other, token));
        if (j < 0) continue;
        next.splice(i, 1);
        next.splice(j, 0, token);
      }
      break;
    case 'send-backward':
      // From the bottom up, each past the nearest one under it that it meets.
      for (let i = 1; i < next.length; i++) {
        const token = next[i];
        if (!picked(token)) continue;
        let j = -1;
        for (let k = i - 1; k >= 0; k--) {
          const other = next[k] as Token;
          if (!picked(other) && meets(other, token)) {
            j = k;
            break;
          }
        }
        if (j < 0) continue;
        next.splice(i, 1);
        next.splice(j, 0, token);
      }
      break;
  }
  return next;
}

/**
 * The drawings after a visual order move of some items: "Bring to front" puts them over every
 * other, "Send to back" under every other (and, outside a group, under the bars); "Bring
 * forward" and "Send backward" move each past the next item it's drawn with, or across the bars
 * (provisional, §11). Several move together, keeping their order; a group moves as one. Items
 * in different groups (or some in a group and some not) can't move together: TradingView's menu
 * then has no Visual order (its GIFs of December 2021 and November 2024). Inside a group they
 * move among its own items. The same list comes back when nothing moves.
 */
export function reorderItems(
  drawings: readonly Drawing[],
  items: readonly GroupItem[],
  move: VisualOrderMove,
): readonly Drawing[] {
  const tops = topItems(drawings, items);
  const parents = new Set(tops.map((item) => parentOf(drawings, item)));
  if (tops.length === 0 || parents.size !== 1) return drawings;
  const parent = [...parents][0] ?? null;
  const picked = new Set(tops.map((item) => `${item.kind === 'group' ? 'g' : 'd'}:${item.id}`));
  let next: Drawing[];
  if (parent === null) {
    // The stack, bottom first: the units under the bars in their order, the bars, the rest.
    const units = unitsOf(drawings, 0, picked);
    const stack: Token[] = [
      ...units.filter((unit) => unit.below),
      BARS,
      ...units.filter((unit) => !unit.below),
    ];
    const tokens = moved(stack, move);
    if (tokens.every((token, i) => token === stack[i])) return drawings;
    const bars = tokens.indexOf(BARS);
    next = tokens.flatMap((token, i) =>
      token === BARS
        ? []
        : token.members.map((drawing) =>
            drawing.below === i < bars ? drawing : { ...drawing, below: i < bars },
          ),
    );
  } else {
    // Inside the group, whose drawings sit together: its own items, one layer.
    const depth = groupPath(drawings, parent)?.length ?? 0;
    const first = drawings.findIndex((drawing) => drawing.groups[depth - 1]?.id === parent);
    const last = drawings.findLastIndex((drawing) => drawing.groups[depth - 1]?.id === parent);
    if (first < 0) return drawings;
    const block = drawings.slice(first, last + 1);
    const units = unitsOf(block, depth, picked);
    const tokens = moved(units, move);
    if (tokens.every((token, i) => token === units[i])) return drawings;
    next = [
      ...drawings.slice(0, first),
      ...tokens.flatMap((token) => (token === BARS ? [] : token.members)),
      ...drawings.slice(last + 1),
    ];
  }
  const normal = normalizeGroups(next);
  return sameArrangement(normal, drawings) ? drawings : normal;
}

/** Visual order for drawings picked on the chart (see reorderItems). */
export function reorderDrawings(
  drawings: readonly Drawing[],
  ids: readonly string[],
  move: VisualOrderMove,
): readonly Drawing[] {
  return reorderItems(
    drawings,
    ids.map((id) => ({ kind: 'drawing', id })),
    move,
  );
}

/**
 * Which moves would change anything: TradingView greys out the others (the Charting Library's
 * AvailableZOrderOperations; its GIF of the main series' menu, October 2025).
 */
export function availableMoves(
  drawings: readonly Drawing[],
  items: readonly GroupItem[],
): Record<VisualOrderMove, boolean> {
  return {
    'bring-to-front': reorderItems(drawings, items, 'bring-to-front') !== drawings,
    'send-to-back': reorderItems(drawings, items, 'send-to-back') !== drawings,
    'bring-forward': reorderItems(drawings, items, 'bring-forward') !== drawings,
    'send-backward': reorderItems(drawings, items, 'send-backward') !== drawings,
  };
}

/**
 * Where the Object tree drops items (docs/SPEC.md §5.27, D3c, D3c2): a pane, into a group or
 * not, just behind an item, or at the front.
 */
export interface TreeTarget {
  /** The pane's key: null for the price pane, else its indicator's id. */
  pane: string | null;
  /** Outside a group: the layer under the pane's series (`below`), or the one over them. */
  below: boolean;
  /** The group they go into, directly; null for none. */
  parent: string | null;
  /** The item of that group (or of the layer) they go just behind; null for the front. */
  before: GroupItem | null;
}

/**
 * The drawings after a drag in the Object tree, which lists them in paint order with its top row
 * at the back (TradingView's own GIF, measured: §4.27): the items of the target's pane, keeping
 * their order and their groups inside them, go into the target's group (or none) just behind
 * `before`, or at the front of that group (or of the layer). Into a group they take its layer;
 * outside, the target's. Not into themselves. The same list back when nothing moves.
 */
export function moveItems(
  drawings: readonly Drawing[],
  items: readonly GroupItem[],
  target: TreeTarget,
): readonly Drawing[] {
  const tops = topItems(drawings, items);
  const levels = itemLevels(drawings, tops);
  const moving = drawings.filter(
    (drawing) => levels.has(drawing.id) && drawing.pane === target.pane,
  );
  if (moving.length === 0) return drawings;
  const movingIds = new Set(moving.map((drawing) => drawing.id));
  const movingGroups = new Set(tops.filter((item) => item.kind === 'group').map((item) => item.id));
  let around: DrawingGroup[] = [];
  if (target.parent !== null) {
    const path = groupPath(drawings, target.parent);
    // Not into one of them, nor into a group inside one.
    if (!path || path.some((group) => movingGroups.has(group.id))) return drawings;
    around = path;
  }
  const { before } = target;
  if (before) {
    const behind =
      before.kind === 'drawing'
        ? drawings.filter((drawing) => drawing.id === before.id)
        : groupMembers(drawings, before.id);
    if (behind.length === 0 || behind.every((drawing) => movingIds.has(drawing.id))) {
      return drawings;
    }
  }
  const pathFor = (drawing: Drawing) => [
    ...around,
    ...drawing.groups.slice(levels.get(drawing.id)),
  ];
  if (moving.some((drawing) => pathFor(drawing).length > MAX_GROUP_DEPTH)) return drawings;
  // Into a group: its layer, as its frontmost drawing that stays has it.
  let below = target.below;
  if (around[0]) {
    const outer = around[0].id;
    const staying = drawings.findLast(
      (drawing) => !movingIds.has(drawing.id) && drawing.groups[0]?.id === outer,
    );
    below = (staying ?? moving.at(-1) ?? { below }).below;
  }
  const placed = moving.map((drawing) => ({ ...drawing, groups: pathFor(drawing), below }));
  const rest = drawings.filter((drawing) => !movingIds.has(drawing.id));
  let at: number;
  if (before) {
    at = rest.findIndex((drawing) =>
      before.kind === 'drawing'
        ? drawing.id === before.id
        : drawing.groups.some((group) => group.id === before.id),
    );
  } else if (target.parent !== null) {
    const parent = target.parent;
    const last = rest.findLastIndex((drawing) => drawing.groups.some((g) => g.id === parent));
    // A group they were all of stays where they were.
    at = last >= 0 ? last + 1 : drawings.findIndex((drawing) => movingIds.has(drawing.id));
  } else {
    at = rest.length;
  }
  if (at < 0) return drawings;
  const next = normalizeGroups([...rest.slice(0, at), ...placed, ...rest.slice(at)]);
  return sameArrangement(next, drawings) ? drawings : next;
}

/** Where the Object tree drops drawings outside any group (D3c's drags; see moveItems). */
export interface TreePlace {
  /** The pane's key: null for the price pane, else its indicator's id. */
  pane: string | null;
  /** The layer under the pane's series (`below`), or the one over them. */
  below: boolean;
  /** The drawing of that pane and layer they go just behind; null for the layer's front. */
  before: string | null;
}

/** Drawings dropped outside any group (see moveItems). */
export function placeDrawings(
  drawings: readonly Drawing[],
  ids: readonly string[],
  place: TreePlace,
): readonly Drawing[] {
  return moveItems(
    drawings,
    ids.map((id) => ({ kind: 'drawing', id })),
    {
      pane: place.pane,
      below: place.below,
      parent: null,
      before: place.before === null ? null : { kind: 'drawing', id: place.before },
    },
  );
}
