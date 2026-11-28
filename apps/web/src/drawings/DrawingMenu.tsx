import type { ChartController } from '@tradingnerd/chart';
import {
  availableMoves,
  type Drawing,
  type GroupItem,
  groupState,
  INTERVAL_PRESET_NAMES,
  INTERVAL_PRESETS,
  isPitchforkTool,
  PITCHFORK_KIND_NAMES,
  PITCHFORK_TOOLS,
  type Resolution,
  sameParent,
  VISUAL_ORDER_MOVES,
  VISUAL_ORDER_NAMES,
} from '@tradingnerd/core';
import { commandShortcut, dragShortcut, isMac } from '../lib/platform';
import { PopupMenu, type PopupMenuEntry } from '../watchlist/PopupMenu';
import { drawingStore, type ToolbarPrefs, useDrawings } from './drawingStore';
import {
  CloneIcon,
  FolderPlusIcon,
  GearIcon,
  HideIcon,
  MenuCheckIcon,
  ObjectTreeIcon,
  PadlockIcon,
  RenameIcon,
  ShowIcon,
  TrashIcon,
} from './icons';
import { objectTreeStore } from './objectTreeStore';
import { templateEntries } from './TemplateMenu';
import { type TemplatesState, useTemplates } from './templateStore';

/** A Mac's delete key, else Delete, as TradingView's menus write Remove's shortcut. */
export const removeShortcut = () => (isMac() ? '⌫' : 'Del');

/**
 * The items of the menu of some drawings (docs/SPEC.md §5.27, D3a, D3c, D3c2), as TradingView's
 * Help Center images show them (43000686263 image 1, 2022; 43000484410's GIF, 2024; 43000660419's
 * GIFs; 43000795451 image 2). On the chart, for one drawing: Template ›, Visual order ›,
 * Visibility on intervals ›, Object Tree… | Clone, Copy | a pitchfork's kinds | Lock, Hide,
 * Remove | Settings…; for several "Object Tree…" first. The Object tree's: Create a group of
 * drawings before Clone, and Rename for one. Template › shows while they're all of one tool (D3b),
 * Visual order › while they're all in the same group or in none (TradingView's menus leave it out
 * otherwise: its GIFs of December 2021 and November 2024), its moves that can't change anything
 * greyed out. Each acts on every drawing given; Remove leaves the locked ones, as the Delete key
 * does.
 */
export function drawingEntries({
  chosen,
  items,
  prefs,
  templates,
  resolution,
  onSelect,
  onSettings,
  onObjectTree,
  onRename,
  onGroup,
}: {
  /** The drawings it acts on, in drawing order (a group's every one). */
  chosen: readonly Drawing[];
  /** What was picked, groups among them (D3c2): the drawings' own, when not given. */
  items?: readonly GroupItem[] | undefined;
  prefs: Pick<ToolbarPrefs, 'lockAll'>;
  templates: TemplatesState;
  /** The chart's interval, which Visibility on intervals' quick choices start from. */
  resolution: Resolution | null;
  /** Selects drawings just added (Clone). */
  onSelect(ids: readonly string[]): void;
  onSettings(): void;
  /** The chart's menu: "Object Tree…" opens the panel. */
  onObjectTree?: (() => void) | undefined;
  /** The Object tree's menu, for one item: "Rename". */
  onRename?: (() => void) | undefined;
  /** The Object tree's menu: "Create a group of drawings". */
  onGroup?: (() => void) | undefined;
}): PopupMenuEntry[] {
  const first = chosen[0];
  if (!first) return [];
  const all = drawingStore.get().drawings;
  const picked = items ?? chosen.map((drawing): GroupItem => ({ kind: 'drawing', id: drawing.id }));
  const { tool } = first;
  const oneTool = chosen.every((drawing) => drawing.tool === tool);
  const ids = chosen.map((drawing) => drawing.id);
  const allLocked = chosen.every((drawing) => drawing.locked);
  const allHidden = chosen.every((drawing) => drawing.hidden);
  const removable = !prefs.lockAll && chosen.some((drawing) => !drawing.locked);
  const oneDrawing = picked.length === 1 && picked[0]?.kind === 'drawing';
  const groups = picked.some((item) => item.kind === 'group');
  const moves = sameParent(all, picked) ? availableMoves(all, picked) : null;
  const template: PopupMenuEntry[] = oneTool
    ? [
        {
          label: 'Template',
          items: templateEntries({
            tool,
            state: templates,
            style: () => first.style,
            onApply: (style) => drawingStore.applyStyle(ids, tool, style),
            several: chosen.length > 1,
          }),
        },
      ]
    : [];
  const visualOrder: PopupMenuEntry[] = moves
    ? [
        {
          label: 'Visual order',
          icon: <ObjectTreeIcon />,
          items: VISUAL_ORDER_MOVES.map((move) => ({
            label: VISUAL_ORDER_NAMES[move],
            disabled: !moves[move],
            onSelect: () => drawingStore.reorderItems(picked, move),
          })),
        },
      ]
    : [];
  const intervals: PopupMenuEntry = {
    // TradingView's words since 2024 (its Help Center's images; "Intervals visibility" before).
    label: 'Visibility on intervals',
    disabled: resolution === null,
    items: INTERVAL_PRESETS.map((preset) => ({
      label: INTERVAL_PRESET_NAMES[preset],
      onSelect: () => {
        if (resolution) drawingStore.setIntervals(ids, preset, resolution);
      },
    })),
  };
  const objectTree: PopupMenuEntry[] = onObjectTree
    ? [{ label: 'Object Tree…', onSelect: onObjectTree }]
    : [];
  const kinds: PopupMenuEntry[] =
    oneDrawing && isPitchforkTool(tool)
      ? [
          'separator',
          ...PITCHFORK_TOOLS.map((kind) => ({
            label: PITCHFORK_KIND_NAMES[kind],
            icon: kind === tool ? <MenuCheckIcon /> : undefined,
            onSelect: () =>
              drawingStore.update(first.id, (drawing) =>
                drawing.tool === kind ? drawing : { ...drawing, tool: kind },
              ),
          })),
        ]
      : [];
  return [
    ...(oneDrawing || !onObjectTree
      ? [...template, ...visualOrder, intervals, ...objectTree]
      : [...objectTree, ...template, ...visualOrder, intervals]),
    'separator',
    ...(onGroup
      ? [{ label: 'Create a group of drawings', icon: <FolderPlusIcon />, onSelect: onGroup }]
      : []),
    {
      label: 'Clone',
      icon: <CloneIcon />,
      shortcut: dragShortcut(),
      // A group isn't cloned (TradingView's tree greys Clone out with one picked: its blog images).
      disabled: groups,
      onSelect: () => onSelect(drawingStore.clone(ids)),
    },
    { label: 'Copy', shortcut: commandShortcut('C'), onSelect: () => drawingStore.copy(ids) },
    ...(onRename && picked.length === 1
      ? [{ label: 'Rename', icon: <RenameIcon />, onSelect: onRename }]
      : []),
    ...kinds,
    'separator',
    {
      label: allLocked ? 'Unlock' : 'Lock',
      icon: <PadlockIcon locked={allLocked} />,
      onSelect: () =>
        drawingStore.updateMany(ids, (drawing) =>
          drawing.locked === !allLocked ? drawing : { ...drawing, locked: !allLocked },
        ),
    },
    {
      // Hidden ones (the Object tree's) show again; TradingView's Hide shows no shortcut.
      label: allHidden ? 'Show' : 'Hide',
      icon: allHidden ? <ShowIcon /> : <HideIcon />,
      onSelect: () => drawingStore.setHidden(ids, !allHidden),
    },
    {
      label: 'Remove',
      icon: <TrashIcon />,
      shortcut: removeShortcut(),
      disabled: !removable,
      onSelect: () => drawingStore.removeUnlocked(ids),
    },
    'separator',
    { label: 'Settings…', icon: <GearIcon />, onSelect: onSettings },
  ];
}

/**
 * A group's menu in the Object tree (D3c2), as TradingView's Help Center GIF shows it
 * (43000660419-1, November 2024; its sync items aren't ours): Rename | Lock, Hide, Remove |
 * Settings…. Lock and Hide act on every drawing in it; Remove leaves the locked ones, as Remove
 * does (provisional for a group, §11).
 */
export function groupEntries({
  members,
  prefs,
  onRename,
  onLock,
  onHide,
  onRemove,
  onSettings,
}: {
  /** The group's drawings, at every level. */
  members: readonly Drawing[];
  prefs: Pick<ToolbarPrefs, 'lockAll' | 'removeLocked'>;
  onRename(): void;
  onLock(locked: boolean): void;
  onHide(hidden: boolean): void;
  onRemove(): void;
  onSettings(): void;
}): PopupMenuEntry[] {
  const state = groupState(members);
  const locked = state.lock === 'locked';
  const hidden = state.visibility === 'invisible';
  const removable =
    (prefs.removeLocked || !prefs.lockAll) &&
    members.some((drawing) => prefs.removeLocked || !drawing.locked);
  return [
    { label: 'Rename', icon: <RenameIcon />, onSelect: onRename },
    'separator',
    {
      label: locked ? 'Unlock' : 'Lock',
      icon: <PadlockIcon locked={locked} />,
      onSelect: () => onLock(!locked),
    },
    {
      label: hidden ? 'Show' : 'Hide',
      icon: hidden ? <ShowIcon /> : <HideIcon />,
      onSelect: () => onHide(!hidden),
    },
    {
      label: 'Remove',
      icon: <TrashIcon />,
      shortcut: removeShortcut(),
      disabled: !removable,
      onSelect: onRemove,
    },
    'separator',
    { label: 'Settings…', icon: <GearIcon />, onSelect: onSettings },
  ];
}

/**
 * The menu of the drawings selected on the chart: a drawing's right-click menu, and the floating
 * toolbar's More (⋯). With groups picked in the tree, they're what its Visual order moves.
 */
export function DrawingMenu({
  x,
  y,
  chart,
  resolution,
  onSettings,
  onClose,
}: {
  x: number;
  y: number;
  chart: ChartController | null;
  resolution: Resolution | null;
  onSettings(): void;
  onClose(): void;
}) {
  const { drawings, selection, prefs } = useDrawings();
  const templates = useTemplates();
  const chosen = drawings.filter((drawing) => selection.includes(drawing.id));
  if (chosen.length === 0) return null;
  const items = drawingStore.pickedItems();
  const entries = drawingEntries({
    chosen,
    items: items.some((item) => item.kind === 'group') ? items : undefined,
    prefs,
    templates,
    resolution,
    onSelect: (copies) => selectAdded(chart, copies),
    onSettings,
    onObjectTree: () => objectTreeStore.show(),
  });
  return <PopupMenu x={x} y={y} label="Drawing" items={entries} onClose={onClose} />;
}

/**
 * Selects drawings just added (cloned, pasted): the chart is given the store's list first, as its
 * own copy follows only after React renders, and a selection names drawings it knows.
 */
export function selectAdded(chart: ChartController | null, ids: readonly string[]): void {
  if (!chart || ids.length === 0) return;
  chart.setDrawings(drawingStore.get().drawings);
  chart.selectDrawings(ids);
}
