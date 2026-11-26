import type { DrawingTool } from '@tradingnerd/core';
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { readJson, writeJson } from '../lib/storage';
import styles from './Drawings.module.css';
import { toolTitle } from './DrawingToolbar';
import { drawingStore } from './drawingStore';
import { GripIcon, TOOL_ICONS } from './icons';

/** Where the favorites toolbar was dragged to, kept in this browser. */
export const FAVORITES_TOOLBAR_KEY = 'tn.drawings.favoritesToolbar';
/**
 * Its first place, until it's dragged: 8 px below the chart's top and 8 px left of the price
 * scale, where autoscale leaves the price pane empty (its top fifth), clear of the legend at the
 * left and of the floating toolbar in the middle (ours: TradingView doesn't say; provisional,
 * §11).
 */
const DEFAULT_TOP = 8;
const DEFAULT_GAP = 8;

interface Place {
  x: number;
  y: number;
}

/** The room it has: its parent's size, and its own. */
interface Room {
  width: number;
  height: number;
  ownWidth: number;
  ownHeight: number;
}

function readPlace(): Place | null {
  const value = readJson(FAVORITES_TOOLBAR_KEY) as Partial<Place> | null;
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: value.x as number, y: value.y as number }
    : null;
}

/** A place kept inside the chart. */
const keptIn = (at: Place, room: Room): Place => ({
  x: Math.min(Math.max(0, room.width - room.ownWidth), Math.max(0, at.x)),
  y: Math.min(Math.max(0, room.height - room.ownHeight), Math.max(0, at.y)),
});

/**
 * TradingView's favorites toolbar (docs/SPEC.md §5.27, D3b): the drawing tools starred in the
 * toolbar's menus, a button each in the order starred, over the chart while there's one
 * (Charting Library, the Favorite Drawings Toolbar "that appears on the chart"; its staff
 * Masterclass: starring a tool creates it, and it can be moved around). A click chooses the
 * tool, or puts it down when it's chosen; the grip moves it, and it stays where it's put. Its
 * look follows the floating toolbar's (provisional, §11).
 */
export function FavoritesToolbar({
  favorites,
  tool,
  rightInset,
}: {
  favorites: readonly DrawingTool[];
  /** The tool being drawn with, or null. */
  tool: DrawingTool | null;
  /** The price scale's width: its first place keeps clear of it. */
  rightInset: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** Where it was dragged to; null until it's moved, when it keeps its first place. */
  const [moved, setMoved] = useState<Place | null>(readPlace);
  const [room, setRoom] = useState<Room | null>(null);

  // Measured after each render: the chart's size can change, and a favorite more widens it.
  useLayoutEffect(() => {
    const element = box.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const next: Room = {
      width: parent.clientWidth,
      height: parent.clientHeight,
      ownWidth: element.offsetWidth,
      ownHeight: element.offsetHeight,
    };
    if (
      !room ||
      next.width !== room.width ||
      next.height !== room.height ||
      next.ownWidth !== room.ownWidth ||
      next.ownHeight !== room.ownHeight
    ) {
      setRoom(next);
    }
  });

  const first = room && {
    x: room.width - room.ownWidth - rightInset - DEFAULT_GAP,
    y: DEFAULT_TOP,
  };
  const place = room && first ? keptIn(moved ?? first, room) : null;

  const grab = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!place || !room) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, place };
    let last = place;
    const move = (moveEvent: PointerEvent) => {
      last = keptIn(
        {
          x: start.place.x + moveEvent.clientX - start.x,
          y: start.place.y + moveEvent.clientY - start.y,
        },
        room,
      );
      setMoved(last);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      writeJson(FAVORITES_TOOLBAR_KEY, last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  return (
    <div
      ref={box}
      className={styles.floating}
      role="toolbar"
      aria-label="Favorite drawing tools"
      style={place ? { left: place.x, top: place.y } : { visibility: 'hidden' }}
    >
      <span className={styles.grip} title="Drag" onPointerDown={grab}>
        <GripIcon />
      </span>
      {favorites.map((favorite) => {
        const Icon = TOOL_ICONS[favorite];
        const title = toolTitle(favorite);
        return (
          <button
            key={favorite}
            type="button"
            className={`${styles.tool} ${styles.favorite}`}
            aria-label={title}
            title={title}
            aria-pressed={tool === favorite}
            onClick={() => drawingStore.setTool(tool === favorite ? null : favorite)}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
