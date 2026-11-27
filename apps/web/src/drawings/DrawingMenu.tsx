import type { ChartController } from '@tradingnerd/chart';
import {
  type Drawing,
  INTERVAL_PRESET_NAMES,
  INTERVAL_PRESETS,
  type Resolution,
  VISUAL_ORDER_MOVES,
  VISUAL_ORDER_NAMES,
} from '@tradingnerd/core';
import { commandShortcut, isMac } from '../lib/platform';
import { PopupMenu, type PopupMenuEntry } from '../watchlist/PopupMenu';
import { drawingStore, type ToolbarPrefs, useDrawings } from './drawingStore';
import { GearIcon, HideIcon, PadlockIcon, RenameIcon, ShowIcon, TrashIcon } from './icons';
import { objectTreeStore } from './objectTreeStore';
import { templateEntries } from './TemplateMenu';
import { type TemplatesState, useTemplates } from './templateStore';

/** A Mac's delete key, else Delete, as TradingView's menus write Remove's shortcut. */
export const removeShortcut = () => (isMac() ? '⌫' : 'Del');

/**
 * The items of the menu of some drawings (docs/SPEC.md §5.27, D3a, D3c), as TradingView's
 * Help Center images show them (43000660419's GIFs, 43000795451 image 2): Template › while
 * they're all of one tool (D3b), Visual order ›, Visibility on intervals › | Clone, Copy (and
 * Rename, the Object tree's, for one) | Lock, Hide, Remove | Settings…. The chart's menu starts
 * with "Object Tree…", as TradingView's for several drawings does (for one, provisional §11).
 * Each acts on every drawing given; Remove leaves the locked ones, as the Delete key does.
 */
export function drawingEntries({
  chosen,
  prefs,
  templates,
  resolution,
  onSelect,
  onSettings,
  onObjectTree,
  onRename,
}: {
  /** The drawings it acts on, in drawing order. */
  chosen: readonly Drawing[];
  prefs: Pick<ToolbarPrefs, 'lockAll'>;
  templates: TemplatesState;
  /** The chart's interval, which Visibility on intervals' quick choices start from. */
  resolution: Resolution | null;
  /** Selects drawings just added (Clone). */
  onSelect(ids: readonly string[]): void;
  onSettings(): void;
  /** The chart's menu: "Object Tree…" opens the panel. */
  onObjectTree?: (() => void) | undefined;
  /** The Object tree's menu, for one drawing: "Rename". */
  onRename?: (() => void) | undefined;
}): PopupMenuEntry[] {
  const first = chosen[0];
  if (!first) return [];
  const { tool } = first;
  const oneTool = chosen.every((drawing) => drawing.tool === tool);
  const ids = chosen.map((drawing) => drawing.id);
  const allLocked = chosen.every((drawing) => drawing.locked);
  const allHidden = chosen.every((drawing) => drawing.hidden);
  const removable = !prefs.lockAll && chosen.some((drawing) => !drawing.locked);
  return [
    ...(onObjectTree ? [{ label: 'Object Tree…', onSelect: onObjectTree }] : []),
    ...(oneTool
      ? [
          {
            label: 'Template',
            items: templateEntries({
              tool,
              state: templates,
              style: () => first.style,
              onApply: (style) => drawingStore.applyStyle(ids, tool, style),
            }),
          },
        ]
      : []),
    {
      label: 'Visual order',
      items: VISUAL_ORDER_MOVES.map((move) => ({
        label: VISUAL_ORDER_NAMES[move],
        onSelect: () => drawingStore.reorder(ids, move),
      })),
    },
    {
      // TradingView's words since 2024 (its Help Center's images; "Intervals visibility" before).
      label: 'Visibility on intervals',
      disabled: resolution === null,
      items: INTERVAL_PRESETS.map((preset) => ({
        label: INTERVAL_PRESET_NAMES[preset],
        onSelect: () => {
          if (resolution) drawingStore.setIntervals(ids, preset, resolution);
        },
      })),
    },
    'separator',
    { label: 'Clone', onSelect: () => onSelect(drawingStore.clone(ids)) },
    { label: 'Copy', shortcut: commandShortcut('C'), onSelect: () => drawingStore.copy(ids) },
    ...(onRename && chosen.length === 1
      ? [{ label: 'Rename', icon: <RenameIcon />, onSelect: onRename }]
      : []),
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
 * The menu of the drawings selected on the chart: a drawing's right-click menu, and the floating
 * toolbar's More (⋯).
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
  const items = drawingEntries({
    chosen,
    prefs,
    templates,
    resolution,
    onSelect: (copies) => selectAdded(chart, copies),
    onSettings,
    onObjectTree: () => objectTreeStore.show(),
  });
  return <PopupMenu x={x} y={y} label="Drawing" items={items} onClose={onClose} />;
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
