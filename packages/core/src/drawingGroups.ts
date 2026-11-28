import {
  type Drawing,
  type DrawingGroup,
  drawingName,
  MAX_GROUP_DEPTH,
  newDrawingId,
} from './drawings.ts';

/**
 * Groups of drawings (docs/SPEC.md §5.27, D3c2), as TradingView's Object tree makes them. Each
 * drawing names the groups it's in, the outermost first (`Drawing.groups`), and TradingView's
 * rules hold after every change (its Charting Library's Drawings API): a drawing is directly in
 * one group at most; "Only drawings of the same pane can be grouped."; "All drawings in the group
 * have sequential z-indexes. Thus, no other object can be placed between drawings in a group.";
 * an empty group can't exist. Groups nest to any depth (its Help Center, How to create nested
 * groups of drawings?, October 2026). Here "front" is the top of the visual order, the end of a
 * symbol's list; the Object tree lists the back first.
 */

/** What the Object tree picks: a drawing, or a group standing for every drawing inside it. */
export interface GroupItem {
  kind: 'drawing' | 'group';
  id: string;
}

/** A group's two states that can be partial (the Charting Library's GroupVisibilityState, GroupLockState). */
export interface GroupState {
  visibility: 'visible' | 'invisible' | 'partial';
  lock: 'locked' | 'unlocked' | 'partial';
}

/** A new group's id: a drawing's kind of id, "g" first. */
export function newGroupId(): string {
  return `g${newDrawingId().slice(1)}`;
}

const inGroup = (drawing: Drawing, id: string) => drawing.groups.some((group) => group.id === id);

/** The drawings in a group, at every level, in drawing order. */
export function groupMembers(drawings: readonly Drawing[], id: string): Drawing[] {
  return drawings.filter((drawing) => inGroup(drawing, id));
}

/** A group's path: the groups around it, the outermost first, then itself; null when it's gone. */
export function groupPath(drawings: readonly Drawing[], id: string): DrawingGroup[] | null {
  for (const drawing of drawings) {
    const at = drawing.groups.findIndex((group) => group.id === id);
    if (at >= 0) return drawing.groups.slice(0, at + 1);
  }
  return null;
}

/** The group an item is directly in, or null for none (or when the item is gone). */
export function parentOf(drawings: readonly Drawing[], item: GroupItem): string | null {
  if (item.kind === 'drawing') {
    return drawings.find((drawing) => drawing.id === item.id)?.groups.at(-1)?.id ?? null;
  }
  return groupPath(drawings, item.id)?.at(-2)?.id ?? null;
}

const itemKey = (item: GroupItem) => `${item.kind === 'group' ? 'g' : 'd'}:${item.id}`;

/**
 * The items that stand on their own: each group picked that isn't inside another picked one, and
 * each drawing picked that isn't inside a picked group; gone ones left out. In drawing order,
 * a group where its back drawing is.
 */
export function topItems(drawings: readonly Drawing[], items: readonly GroupItem[]): GroupItem[] {
  const groups = new Set(items.filter((item) => item.kind === 'group').map((item) => item.id));
  const ids = new Set(items.filter((item) => item.kind === 'drawing').map((item) => item.id));
  const tops: GroupItem[] = [];
  const seen = new Set<string>();
  for (const drawing of drawings) {
    const outer = drawing.groups.find((group) => groups.has(group.id));
    const item: GroupItem | null = outer
      ? { kind: 'group', id: outer.id }
      : ids.has(drawing.id)
        ? { kind: 'drawing', id: drawing.id }
        : null;
    if (item && !seen.has(itemKey(item))) {
      seen.add(itemKey(item));
      tops.push(item);
    }
  }
  return tops;
}

/**
 * The drawings of some items, each with the depth its item starts at among its groups: a picked
 * drawing its own depth (its groups' count), a picked group's drawings that group's place.
 */
export function itemLevels(
  drawings: readonly Drawing[],
  items: readonly GroupItem[],
): Map<string, number> {
  const tops = topItems(drawings, items);
  const groups = new Set(tops.filter((item) => item.kind === 'group').map((item) => item.id));
  const ids = new Set(tops.filter((item) => item.kind === 'drawing').map((item) => item.id));
  const levels = new Map<string, number>();
  for (const drawing of drawings) {
    const at = drawing.groups.findIndex((group) => groups.has(group.id));
    if (at >= 0) levels.set(drawing.id, at);
    else if (ids.has(drawing.id)) levels.set(drawing.id, drawing.groups.length);
  }
  return levels;
}

/** True when the items are all directly in the same group, or all in none. */
export function sameParent(drawings: readonly Drawing[], items: readonly GroupItem[]): boolean {
  const tops = topItems(drawings, items);
  return tops.length > 0 && new Set(tops.map((item) => parentOf(drawings, item))).size === 1;
}

const sameGroups = (a: readonly DrawingGroup[], b: readonly DrawingGroup[]) =>
  a.length === b.length &&
  a.every((group, i) => group.id === b[i]?.id && group.name === b[i]?.name);

/** True when two lists hold the same drawings in the same order, in the same groups and layers. */
export function sameArrangement(a: readonly Drawing[], b: readonly Drawing[]): boolean {
  return (
    a.length === b.length &&
    a.every((drawing, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        drawing.id === other.id &&
        drawing.below === other.below &&
        sameGroups(drawing.groups, other.groups)
      );
    })
  );
}

/**
 * The list with TradingView's group rules holding (the same list back when they already did):
 * - each group sits where its first drawing in the list says (its parent and its name);
 * - an outermost group's drawings take its frontmost drawing's layer (over or under the bars),
 *   and one on another pane leaves it;
 * - each group's drawings come together where its frontmost drawing is, the rest keeping their
 *   order (the old Charting Library docs' createGroupFromSelection: "This function moves all the
 *   shapes to the top one, while keeping their order").
 */
export function normalizeGroups(drawings: readonly Drawing[]): readonly Drawing[] {
  if (!drawings.some((drawing) => drawing.groups.length > 0)) return drawings;
  // Each group's parent and name, as the first drawing naming it has them.
  const info = new Map<string, { parent: string | null; name: string }>();
  for (const drawing of drawings) {
    drawing.groups.forEach((group, i) => {
      if (!info.has(group.id)) {
        info.set(group.id, { parent: drawing.groups[i - 1]?.id ?? null, name: group.name });
      }
    });
  }
  const pathOf = (innermost: string): DrawingGroup[] => {
    const path: DrawingGroup[] = [];
    const seen = new Set<string>();
    for (
      let id: string | null = innermost;
      id !== null && !seen.has(id) && path.length < MAX_GROUP_DEPTH;
      id = info.get(id)?.parent ?? null
    ) {
      seen.add(id);
      path.unshift({ id, name: info.get(id)?.name ?? '' });
    }
    return path;
  };
  const paths = drawings.map((drawing) => {
    const innermost = drawing.groups.at(-1);
    return innermost ? pathOf(innermost.id) : [];
  });
  // Each outermost group's pane and layer: its frontmost drawing's.
  const outer = new Map<string, { pane: string | null; below: boolean }>();
  for (let i = drawings.length - 1; i >= 0; i--) {
    const root = paths[i]?.[0];
    const drawing = drawings[i];
    if (root && drawing && !outer.has(root.id)) {
      outer.set(root.id, { pane: drawing.pane, below: drawing.below });
    }
  }
  const layers = drawings.map((drawing, i) => {
    const root = paths[i]?.[0];
    const home = root ? outer.get(root.id) : undefined;
    if (!home) return drawing.below;
    if (home.pane !== drawing.pane) {
      paths[i] = [];
      return drawing.below;
    }
    return home.below;
  });
  // A tree of the groups, each placed by its frontmost drawing, walked back to front.
  interface Node {
    anchor: number;
    index: number;
    children: Node[];
  }
  const root: Node = { anchor: -1, index: -1, children: [] };
  const nodes = new Map<string, Node>();
  drawings.forEach((_, i) => {
    let parent = root;
    for (const group of paths[i] ?? []) {
      let node = nodes.get(group.id);
      if (!node) {
        node = { anchor: i, index: -1, children: [] };
        nodes.set(group.id, node);
        parent.children.push(node);
      }
      node.anchor = i;
      parent = node;
    }
    parent.children.push({ anchor: i, index: i, children: [] });
  });
  const order: number[] = [];
  const walk = (node: Node) => {
    node.children.sort((a, b) => a.anchor - b.anchor);
    for (const child of node.children) {
      if (child.index >= 0) order.push(child.index);
      else walk(child);
    }
  };
  walk(root);
  let changed = false;
  const next = order.map((i, k) => {
    const drawing = drawings[i] as Drawing;
    const groups = paths[i] ?? [];
    const below = layers[i] ?? drawing.below;
    const same = below === drawing.below && sameGroups(groups, drawing.groups);
    if (!same || i !== k) changed = true;
    return same ? drawing : { ...drawing, groups, below };
  });
  return changed ? next : drawings;
}

/**
 * A new group's name: "Group 1", then one more than the highest "Group N" the symbol's groups
 * have (TradingView's names "Group 1", "Group 2", "Group 3" made one after another: its Help
 * Center image, October 2026; after a rename or a removal it isn't seen: provisional, §11).
 */
export function nextGroupName(drawings: readonly Drawing[]): string {
  let last = 0;
  for (const drawing of drawings) {
    for (const group of drawing.groups) {
      const match = /^Group (\d{1,6})$/.exec(group.name);
      if (match) last = Math.max(last, Number(match[1]));
    }
  }
  return `Group ${last + 1}`;
}

/**
 * The list with the items in a new group (the Object tree's "Create a group of drawings"), or
 * null when they can't be grouped: none there, on more than one pane (the Charting Library's
 * createGroupFromSelection refuses them), or nested too deep. The group takes the place of the
 * frontmost item, inside the groups that one is in; the others come to sit just behind it,
 * keeping their order (the old Charting Library docs: "moves all the shapes to the top one").
 */
export function createGroup(
  drawings: readonly Drawing[],
  items: readonly GroupItem[],
  group: DrawingGroup,
): readonly Drawing[] | null {
  const levels = itemLevels(drawings, items);
  const members = drawings.filter((drawing) => levels.has(drawing.id));
  const front = members.at(-1);
  if (!front || new Set(members.map((drawing) => drawing.pane)).size > 1) return null;
  const around = front.groups.slice(0, levels.get(front.id));
  const pathFor = (drawing: Drawing) => [
    ...around,
    group,
    ...drawing.groups.slice(levels.get(drawing.id)),
  ];
  if (members.some((drawing) => pathFor(drawing).length > MAX_GROUP_DEPTH)) return null;
  return normalizeGroups(
    drawings.map((drawing) =>
      levels.has(drawing.id) ? { ...drawing, groups: pathFor(drawing) } : drawing,
    ),
  );
}

/** The list with a group renamed on each of its drawings; the same list for an empty name. */
export function renameGroup(
  drawings: readonly Drawing[],
  id: string,
  name: string,
): readonly Drawing[] {
  const kept = drawingName(name);
  if (!kept) return drawings;
  let changed = false;
  const next = drawings.map((drawing) => {
    if (!drawing.groups.some((group) => group.id === id && group.name !== kept)) return drawing;
    changed = true;
    return {
      ...drawing,
      groups: drawing.groups.map((group) => (group.id === id ? { ...group, name: kept } : group)),
    };
  });
  return changed ? next : drawings;
}

/** A group's eye and padlock from its drawings: partial when they differ. */
export function groupState(members: readonly Drawing[]): GroupState {
  const hidden = members.filter((drawing) => drawing.hidden).length;
  const locked = members.filter((drawing) => drawing.locked).length;
  const all = members.length;
  return {
    visibility: hidden === 0 ? 'visible' : hidden === all ? 'invisible' : 'partial',
    lock: locked === 0 ? 'unlocked' : locked === all ? 'locked' : 'partial',
  };
}

/**
 * The groups a new drawing joins (TradingView's toolbar, shortcut and paste: "placed into the
 * group of the previously selected drawing or group", its Charting Library v32.0.0, 1 July
 * 2026): a group picked alone, else the group the picked drawings are all directly in; none
 * when they're in different ones or in none.
 */
export function joinPath(
  drawings: readonly Drawing[],
  items: readonly GroupItem[],
): DrawingGroup[] {
  const tops = topItems(drawings, items);
  const first = tops[0];
  if (!first) return [];
  if (first.kind === 'group') return tops.length === 1 ? (groupPath(drawings, first.id) ?? []) : [];
  if (tops.some((item) => item.kind === 'group') || !sameParent(drawings, tops)) return [];
  return drawings.find((drawing) => drawing.id === first.id)?.groups.slice() ?? [];
}

/**
 * The list after drawings were added (drawn, cloned or pasted, the new ones at its end): each
 * new one naming a group goes to that group's front, the group keeping its place (the Charting
 * Library v33.0.0, 13 October 2026: "the group keeps its position, and the clone is added at the
 * top of its own group"); one whose group is on another pane, or gone, leaves it.
 */
export function placeNewDrawings(
  previous: readonly Drawing[],
  next: readonly Drawing[],
): readonly Drawing[] {
  const known = new Set(previous.map((drawing) => drawing.id));
  const added = new Set(
    next.filter((drawing) => !known.has(drawing.id) && drawing.groups.length > 0),
  );
  if (added.size === 0) return normalizeGroups(next);
  const list = next.filter((drawing) => !added.has(drawing));
  for (const drawing of added) {
    const inner = drawing.groups.at(-1)?.id ?? '';
    const last = list.findLastIndex((other) => inGroup(other, inner));
    const host = list[last];
    if (!host || host.pane !== drawing.pane) {
      list.push({ ...drawing, groups: [] });
      continue;
    }
    const depth = host.groups.findIndex((group) => group.id === inner) + 1;
    list.splice(last + 1, 0, {
      ...drawing,
      groups: host.groups.slice(0, depth),
      below: host.below,
    });
  }
  return normalizeGroups(list);
}
