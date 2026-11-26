import type { ChartController } from '@tradingnerd/chart';
import {
  INTERVAL_PRESET_NAMES,
  INTERVAL_PRESETS,
  type Resolution,
  VISUAL_ORDER_MOVES,
  VISUAL_ORDER_NAMES,
} from '@tradingnerd/core';
import { commandShortcut, isMac } from '../lib/platform';
import { PopupMenu, type PopupMenuEntry } from '../watchlist/PopupMenu';
import { drawingStore, useDrawings } from './drawingStore';
import { GearIcon, PadlockIcon, TrashIcon } from './icons';
import { templateEntries } from './TemplateMenu';
import { useTemplates } from './templateStore';

/**
 * The menu of the drawings selected (docs/SPEC.md §5.27, D3a): a drawing's right-click menu, and
 * the floating toolbar's More (⋯). TradingView's Help Center names its Visual order and its
 * Intervals visibility quick choices, both offered from the right-click and from the ⋯, and its
 * Charting Library the actions Clone, Copy, Lock, Remove and Settings; the items' order, icons
 * and words are provisional until measured from a screenshot (§11). Each acts on every drawing
 * selected; Remove leaves the locked ones, as the Delete key does. Template › (D3b) comes first
 * while they're all of one tool, as TradingView offers templates only for tools of one type
 * (Help Center, How to apply a template to several tools of the same type at once?).
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
  /** The chart's interval, which Intervals visibility's quick choices start from. */
  resolution: Resolution | null;
  onSettings(): void;
  onClose(): void;
}) {
  const { drawings, selection, prefs } = useDrawings();
  const templates = useTemplates();
  const chosen = drawings.filter((drawing) => selection.includes(drawing.id));
  const first = chosen[0];
  if (!first) return null;
  const { tool } = first;
  const oneTool = chosen.every((drawing) => drawing.tool === tool);
  const ids = chosen.map((drawing) => drawing.id);
  const allLocked = chosen.every((drawing) => drawing.locked);
  const removable = !prefs.lockAll && chosen.some((drawing) => !drawing.locked);
  const select = (copies: readonly string[]) => selectAdded(chart, copies);
  const items: PopupMenuEntry[] = [
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
      label: 'Intervals visibility',
      disabled: resolution === null,
      items: INTERVAL_PRESETS.map((preset) => ({
        label: INTERVAL_PRESET_NAMES[preset],
        onSelect: () => {
          if (resolution) drawingStore.setIntervals(ids, preset, resolution);
        },
      })),
    },
    'separator',
    { label: 'Clone', onSelect: () => select(drawingStore.clone(ids)) },
    { label: 'Copy', shortcut: commandShortcut('C'), onSelect: () => drawingStore.copy(ids) },
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
      label: 'Remove',
      icon: <TrashIcon />,
      // A Mac's delete key, else Delete (ours, provisional §11).
      shortcut: isMac() ? '⌫' : 'Del',
      disabled: !removable,
      onSelect: () => drawingStore.removeUnlocked(ids),
    },
    'separator',
    { label: 'Settings…', icon: <GearIcon />, onSelect: onSettings },
  ];
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
