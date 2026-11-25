import {
  type Bar,
  type Drawing,
  type DrawingPoint,
  type DrawingTool,
  newDrawing,
  type Resolution,
  TOOL_POINTS,
  visibleOn,
} from '@tradingnerd/core';
import {
  distanceToSegment,
  HANDLE_HIT,
  LINE_HIT,
  lineSegment,
  type Pt,
  type Size,
  snap45,
} from './geometry';
import { type MagnetMode, magnetPrice } from './magnet';
import { TimeMap } from './timeMap';

/**
 * The user's drawings on the chart (docs/SPEC.md §6.24, milestone D1): which are drawn on each
 * pane and where, the pointer's work on them (placing a tool's points, selecting, dragging a
 * point or the whole drawing, Shift's 45°, Ctrl/⌘ + drag to clone, the eraser) and the toolbar's
 * modes (magnet, keep drawing, lock and hide all). The app keeps the drawings (per symbol, saved,
 * with undo); the engine tells it of each edit and is given the new list back.
 */

/** TradingView's cursors (the left toolbar's first button). */
export type CursorMode = 'cross' | 'dot' | 'arrow' | 'eraser';

export interface DrawingSettings {
  /** The tool being drawn with, or none (the cursor). */
  tool: DrawingTool | null;
  cursor: CursorMode;
  magnetOn: boolean;
  /** The magnet's strength, kept while it's off. */
  magnet: MagnetMode;
  /** "Keep drawing": a tool stays chosen after each drawing (TradingView's Stay in drawing mode). */
  keepDrawing: boolean;
  /** Lock all drawings: none moves, changes or goes with Delete. */
  lockAll: boolean;
  /** Hide all drawings. */
  hideAll: boolean;
}

export const DEFAULT_DRAWING_SETTINGS: Readonly<DrawingSettings> = Object.freeze({
  tool: null,
  cursor: 'cross',
  magnetOn: false,
  magnet: 'weak',
  keepDrawing: false,
  lockAll: false,
  hideAll: false,
});

/** What the engine needs of the chart; ChartController gives it, the tests a fake. */
export interface DrawingHost {
  /** Pane x of a logical index, fractional ones too; null without bars. */
  logicalToX(logical: number): number | null;
  /** The logical index at a pane x, unrounded; null without bars. */
  xToLogical(x: number): number | null;
  /** Pane y of a price on pane `pane` (0 is the price pane). */
  priceToY(pane: number, price: number): number | null;
  yToPrice(pane: number, y: number): number | null;
  /** A pane's key: null for the price pane, its indicator's id for another; undefined if none. */
  paneKey(pane: number): string | null | undefined;
  /** The pane a key names now, or null when it isn't on the chart. */
  paneIndex(key: string | null): number | null;
  paneSize(pane: number): Size | null;
  bars(): readonly Bar[];
  resolution(): Resolution | null;
  /** Repaint the drawings. */
  requestUpdate(): void;
  /** The chart's own dragging (pan and scale), off while a drawing is being drawn or dragged. */
  setPanning(enabled: boolean): void;
  /** The cursor over the panes: a CSS cursor, or null for the chart's own. */
  setCursor(cursor: string | null): void;
}

export interface DrawingEvents {
  /** The drawings after an edit, in drawing order (the last on top). */
  onEdit?(drawings: Drawing[]): void;
  onSelect?(ids: readonly string[]): void;
  /** A drawing was finished (or cancelled) and Keep drawing is off: the tool goes back to the cursor. */
  onToolDone?(): void;
  /** A drawing was double-clicked: its settings open (TradingView's). */
  onOpen?(id: string): void;
  /** A new drawing's id. */
  newId?(): string;
}

/** A pointer event on a pane, in that pane's CSS px. */
export interface PointerInput {
  pane: number;
  x: number;
  y: number;
  shift: boolean;
  /** Ctrl, or ⌘ on a Mac. */
  mod: boolean;
}

/** A handle of a drawing shown selected or hovered: where it is and which point it moves. */
export interface Handle extends Pt {
  point: number;
  /** A rounded square (a horizontal or vertical line's), else a circle. */
  square: boolean;
}

/** A drawing as shown on one pane. */
export interface PlacedShape {
  drawing: Drawing;
  /** Its points on this pane, in order; null where one can't be placed (no bars). */
  points: (Pt | null)[];
  /** The line between its two points, for its text and stats; null for one-point tools. */
  segment: [Pt, Pt] | null;
  /** Its lines as drawn, carried to the pane's edges where they extend. */
  lines: [Pt, Pt][];
  /** Ends with an arrow: its tip, and the point it points away from. */
  arrows: [Pt, Pt][];
  handles: Handle[];
  /** Anchored on this pane (not a vertical line from another). */
  own: boolean;
  /** The pane it's shown on, and its size. */
  pane: number;
  size: Size;
}

/** The pointer must move this far before a press counts as a drag, CSS px. */
const DRAG_START = 3;
/** Beyond the pane's edges a full-width or full-height line runs this far, so its end never shows. */
const EDGE = 4;
/** Where a horizontal line's handle sits across the pane, and a vertical line's down it. */
const SIDE_HANDLE = 0.9;
const PREVIEW_ID = 'preview';

interface Placing {
  tool: DrawingTool;
  pane: number;
  key: string | null;
  points: DrawingPoint[];
  /** The pointer is down. */
  pressed: boolean;
  downAt: Pt;
  dragged: boolean;
  /** The last point's press has come: the drawing is done when it's let go. */
  closing: boolean;
}

interface Drag {
  id: string;
  /** The point being dragged, or null for the whole drawing. */
  handle: number | null;
  pane: number;
  start: PointerInput;
  startLogical: number | null;
  original: Drawing;
  current: Drawing;
  /** Ctrl/⌘ at the press: the drag moves a copy, the drawing stays. */
  cloneId: string | null;
  moved: boolean;
}

let counter = 0;
const randomId = () => `d${Date.now().toString(36)}${(counter++).toString(36)}`;

export class DrawingEngine {
  private readonly host: DrawingHost;
  private readonly events: DrawingEvents;
  private drawings: Drawing[] = [];
  private settings: DrawingSettings = { ...DEFAULT_DRAWING_SETTINGS };
  private selected: string[] = [];
  private hover: string | null = null;
  /** The handle under the pointer: its drawing and point. */
  private hoverHandle: { id: string; point: number } | null = null;
  private placing: Placing | null = null;
  private drag: Drag | null = null;
  private map: TimeMap | null = null;
  private panningOff = false;
  private cursor: string | null | undefined = undefined;

  constructor(host: DrawingHost, events: DrawingEvents = {}) {
    this.host = host;
    this.events = events;
  }

  // ---- the app's side ----

  /** The chart symbol's drawings, as the app keeps them (in drawing order). */
  setDrawings(drawings: readonly Drawing[]): void {
    this.drawings = drawings.slice();
    const ids = new Set(this.drawings.map((drawing) => drawing.id));
    if (this.drag && !ids.has(this.drag.id)) this.endDrag();
    const kept = this.selected.filter((id) => ids.has(id));
    if (kept.length !== this.selected.length) this.setSelection(kept);
    if (this.hover && !ids.has(this.hover)) this.setHover(null, null);
    this.update();
  }

  current(): readonly Drawing[] {
    return this.drawings;
  }

  setSettings(settings: Partial<DrawingSettings>): void {
    const before = this.settings;
    this.settings = { ...before, ...settings };
    if (this.placing && this.settings.tool !== this.placing.tool) this.stopPlacing();
    if (this.settings.hideAll && !before.hideAll) this.setSelection([]);
    if (this.settings.tool) this.setHover(null, null);
    this.update();
  }

  drawingSettings(): Readonly<DrawingSettings> {
    return this.settings;
  }

  /** The bars or their interval changed: anchor times map to new places. */
  barsChanged(): void {
    this.map = null;
    this.host.requestUpdate();
  }

  selection(): readonly string[] {
    return this.selected;
  }

  select(ids: readonly string[]): void {
    const known = new Set(this.drawings.map((drawing) => drawing.id));
    this.setSelection(ids.filter((id) => known.has(id)));
    this.update();
  }

  /** The pane a drawing being placed or dragged is on: the pointer's moves are read there. */
  activePane(): number | null {
    return this.placing?.pane ?? this.drag?.pane ?? null;
  }

  /**
   * Escape: a drawing being placed or dragged is let go, else the selection, else the tool.
   * True when it did something.
   */
  cancel(): boolean {
    if (this.placing) {
      this.stopPlacing();
      this.events.onToolDone?.();
      this.update();
      return true;
    }
    if (this.drag) {
      this.endDrag();
      this.update();
      return true;
    }
    if (this.selected.length > 0) {
      this.setSelection([]);
      this.update();
      return true;
    }
    if (this.settings.tool) {
      this.events.onToolDone?.();
      return true;
    }
    return false;
  }

  /** Delete: the selected drawings go, but locked ones (TradingView's lock). True when any went. */
  removeSelected(): boolean {
    if (this.settings.lockAll) return false;
    const going = new Set(this.selected.filter((id) => !this.find(id)?.locked));
    if (going.size === 0) return false;
    this.setSelection(this.selected.filter((id) => !going.has(id)));
    this.edit(this.drawings.filter((drawing) => !going.has(drawing.id)));
    return true;
  }

  // ---- the pointer ----

  /** A press on a pane. True when the drawings take it, so the chart doesn't pan. */
  pointerDown(input: PointerInput): boolean {
    const key = this.host.paneKey(input.pane);
    if (key === undefined) return false;
    const { tool, cursor } = this.settings;
    if (tool) {
      this.press(tool, input, key);
      this.suspend();
      this.update();
      return true;
    }
    const hit = this.hitTest(input.pane, input.x, input.y);
    if (!hit) {
      if (this.selected.length > 0) this.setSelection([]);
      this.update();
      return false;
    }
    const drawing = this.find(hit.id);
    if (!drawing) return false;
    const fixed = drawing.locked || this.settings.lockAll;
    if (cursor === 'eraser') {
      if (!fixed) {
        this.setSelection(this.selected.filter((id) => id !== drawing.id));
        this.setHover(null, null);
        this.edit(this.drawings.filter((item) => item.id !== drawing.id));
      }
      this.suspend();
      return true;
    }
    this.setSelection([drawing.id]);
    this.suspend();
    if (!fixed) {
      this.drag = {
        id: drawing.id,
        handle: hit.handle,
        pane: input.pane,
        start: input,
        startLogical: this.host.xToLogical(input.x),
        original: drawing,
        current: drawing,
        cloneId: input.mod && hit.handle === null ? this.newId() : null,
        moved: false,
      };
    }
    this.update();
    return true;
  }

  /** The pointer moved: `pressed` while a button is down. Null when it left the panes. */
  pointerMove(input: PointerInput | null, pressed: boolean): void {
    if (this.placing) {
      if (input && input.pane === this.placing.pane) this.movePlacing(input);
      this.update();
      return;
    }
    if (this.drag) {
      if (pressed && input) this.moveDrag(input);
      return;
    }
    if (pressed) return;
    const hit = input && !this.settings.tool ? this.hitTest(input.pane, input.x, input.y) : null;
    const handle = hit && hit.handle !== null ? { id: hit.id, point: hit.handle } : null;
    if (this.setHover(hit?.id ?? null, handle)) this.update();
    else this.updateCursor();
  }

  /** The press was let go. */
  pointerUp(input: PointerInput | null): void {
    const placing = this.placing;
    if (placing) {
      if (input && input.pane === placing.pane) this.movePlacing(input);
      placing.pressed = false;
      const single = TOOL_POINTS[placing.tool] === 1;
      if (single || placing.closing || placing.dragged) this.finishPlacing();
      this.update();
      return;
    }
    const drag = this.drag;
    if (drag) {
      this.endDrag();
      if (drag.moved) {
        const next = drag.cloneId
          ? [...this.drawings, drag.current]
          : this.drawings.map((item) => (item.id === drag.id ? drag.current : item));
        this.edit(next);
        if (drag.cloneId) this.setSelection([drag.cloneId]);
      }
    }
    this.resume();
    this.update();
  }

  // ---- what's drawn ----

  /** The drawings shown on a pane, bottom first, with the one being placed or dragged as it is now. */
  shapes(pane: number): PlacedShape[] {
    const size = this.host.paneSize(pane);
    const key = this.host.paneKey(pane);
    if (!size || key === undefined) return [];
    const shapes: PlacedShape[] = [];
    for (const drawing of this.shown()) {
      const own = drawing.pane === key;
      // A vertical line crosses every pane (the capture's extendLine), its handle on its own.
      const across = drawing.tool === 'vertical-line' || drawing.tool === 'cross-line';
      if (!own && !(across && this.host.paneIndex(drawing.pane) !== null)) continue;
      const shape = this.shapeOf(drawing, pane, size, own);
      if (shape) shapes.push(shape);
    }
    return shapes;
  }

  /** Shown selected: its handles with the thicker ring (the drawing being placed is too). */
  isSelected(id: string): boolean {
    return this.selected.includes(id) || id === PREVIEW_ID || id === this.drag?.cloneId;
  }

  /** Shows its handles: selected, or hovered while it can be moved. */
  showsHandles(drawing: Drawing): boolean {
    if (this.isSelected(drawing.id)) return true;
    return drawing.id === this.hover && !drawing.locked && !this.settings.lockAll;
  }

  /** The handle under the pointer, for its halo. */
  hoveredHandle(): { id: string; point: number } | null {
    return this.hoverHandle;
  }

  isHovered(id: string): boolean {
    return id === this.hover;
  }

  /** The logical index of a time, for the stats' bar counts. */
  logicalOf(time: number): number {
    return this.timeMap().logicalOf(time);
  }

  /** The time at a logical index, past the bars at the interval's length. */
  timeOfLogical(logical: number): number {
    return this.timeMap().timeOf(logical);
  }

  /** Pane x of an anchor time, or null without bars. */
  timeToX(time: number): number | null {
    const logical = this.timeMap().logicalOf(time);
    return Number.isFinite(logical) ? this.host.logicalToX(logical) : null;
  }

  /**
   * The topmost drawing at a point on a pane, and which of its points when it's on a handle: a
   * shown handle first (the nearest), then any line.
   */
  hitTest(pane: number, x: number, y: number): { id: string; handle: number | null } | null {
    if (this.settings.hideAll) return null;
    const shapes = this.shapes(pane).filter((shape) => shape.drawing.id !== PREVIEW_ID);
    const at = { x, y };
    let best: { id: string; handle: number; distance: number } | null = null;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i] as PlacedShape;
      if (!this.showsHandles(shape.drawing)) continue;
      for (const handle of shape.handles) {
        const distance = Math.hypot(handle.x - x, handle.y - y);
        if (distance <= HANDLE_HIT && (!best || distance < best.distance)) {
          best = { id: shape.drawing.id, handle: handle.point, distance };
        }
      }
    }
    if (best) return { id: best.id, handle: best.handle };
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i] as PlacedShape;
      const reach = LINE_HIT + shape.drawing.style.width / 2;
      if (shape.lines.some(([a, b]) => distanceToSegment(at, a, b) <= reach)) {
        return { id: shape.drawing.id, handle: null };
      }
    }
    return null;
  }

  debug(): {
    drawings: Drawing[];
    selection: string[];
    placing: { tool: DrawingTool; points: DrawingPoint[] } | null;
    dragging: string | null;
    hover: string | null;
    cursor: string | null;
    settings: DrawingSettings;
  } {
    return {
      drawings: this.drawings.slice(),
      selection: this.selected.slice(),
      placing: this.placing
        ? { tool: this.placing.tool, points: this.placing.points.map((p) => ({ ...p })) }
        : null,
      dragging: this.drag?.id ?? null,
      hover: this.hover,
      cursor: this.cursor ?? null,
      settings: { ...this.settings },
    };
  }

  // ---- inside ----

  private find(id: string): Drawing | undefined {
    return this.drawings.find((drawing) => drawing.id === id);
  }

  private timeMap(): TimeMap {
    this.map ??= TimeMap.fromBars(this.host.bars(), this.host.resolution());
    return this.map;
  }

  private newId(): string {
    return this.events.newId?.() ?? randomId();
  }

  private setSelection(ids: string[]): void {
    const same =
      ids.length === this.selected.length && ids.every((id, i) => id === this.selected[i]);
    if (same) return;
    this.selected = ids;
    this.events.onSelect?.(ids.slice());
  }

  /** True when the hovered drawing or handle changed. */
  private setHover(id: string | null, handle: { id: string; point: number } | null): boolean {
    const before = this.hoverHandle;
    const same = id === this.hover && before?.id === handle?.id && before?.point === handle?.point;
    this.hover = id;
    this.hoverHandle = handle;
    return !same;
  }

  private edit(next: Drawing[]): void {
    this.drawings = next;
    this.events.onEdit?.(next.slice());
    this.update();
  }

  /** The drawings to show now: hidden ones and those off on this interval left out. */
  private shown(): Drawing[] {
    const resolution = this.host.resolution();
    const visible = (drawing: Drawing) =>
      !drawing.hidden && (!resolution || visibleOn(drawing.visibility, resolution));
    const list = this.settings.hideAll ? [] : this.drawings.filter(visible);
    const drag = this.drag;
    let shown = list;
    if (drag?.moved) {
      shown = drag.cloneId
        ? [...list, drag.current]
        : list.map((item) => (item.id === drag.id ? drag.current : item));
    }
    if (this.placing) {
      const { tool, points, key } = this.placing;
      shown = [...shown, newDrawing(PREVIEW_ID, tool, points, key)];
    }
    return shown;
  }

  private shapeOf(drawing: Drawing, pane: number, size: Size, own: boolean): PlacedShape | null {
    const { style } = drawing;
    const points: (Pt | null)[] = drawing.points.map((point) => {
      const x = this.timeToX(point.time);
      const y = own ? this.host.priceToY(pane, point.price) : 0;
      return x === null || y === null ? null : { x, y };
    });
    const shape: PlacedShape = {
      drawing,
      points,
      segment: null,
      lines: [],
      arrows: [],
      handles: [],
      own,
      pane,
      size,
    };
    const first = drawing.points[0];
    if (!first) return null;
    const x0 = this.timeToX(first.time);
    const y0 = own ? this.host.priceToY(pane, first.price) : null;
    const across = (x: number) =>
      shape.lines.push([
        { x, y: -EDGE },
        { x, y: size.height + EDGE },
      ]);
    const along = (from: number, y: number) =>
      shape.lines.push([
        { x: from, y },
        { x: size.width + EDGE, y },
      ]);
    switch (drawing.tool) {
      case 'horizontal-line': {
        if (y0 === null) return null;
        along(-EDGE, y0);
        shape.handles.push({ x: size.width * SIDE_HANDLE, y: y0, point: 0, square: true });
        return shape;
      }
      case 'horizontal-ray': {
        if (y0 === null || x0 === null) return null;
        along(x0, y0);
        shape.handles.push({ x: x0, y: y0, point: 0, square: false });
        return shape;
      }
      case 'vertical-line': {
        if (x0 === null) return null;
        across(x0);
        if (own)
          shape.handles.push({ x: x0, y: size.height * SIDE_HANDLE, point: 0, square: true });
        return shape;
      }
      case 'cross-line': {
        if (x0 === null) return null;
        across(x0);
        if (own && y0 !== null) {
          along(-EDGE, y0);
          shape.handles.push({ x: x0, y: y0, point: 0, square: false });
        }
        return shape;
      }
      default: {
        const [a, b] = points;
        if (!own || !a || !b) return null;
        shape.segment = [a, b];
        shape.handles.push({ ...a, point: 0, square: false }, { ...b, point: 1, square: false });
        const segment = lineSegment(a, b, style.extendLeft, style.extendRight, size);
        if (segment) shape.lines.push(segment);
        const ends = drawing.tool !== 'trend-angle';
        if (ends && style.leftEnd === 'arrow' && !style.extendLeft) shape.arrows.push([a, b]);
        if (ends && style.rightEnd === 'arrow' && !style.extendRight) shape.arrows.push([b, a]);
        return shape;
      }
    }
  }

  /** The point at a pane position: its bar's time, and its price, the magnet's if it's on. */
  private pointAt(
    pane: number,
    x: number,
    y: number,
    magnet: MagnetMode | null,
  ): DrawingPoint | null {
    const logical = this.host.xToLogical(x);
    let price = this.host.yToPrice(pane, y);
    if (logical === null || price === null) return null;
    const index = Math.round(logical);
    const map = this.timeMap();
    if (map.length === 0) return null;
    // The magnet takes the bars' prices, which only the price pane has.
    if (magnet && this.host.paneKey(pane) === null) {
      const bar = this.host.bars()[index];
      if (bar) {
        const snapped = magnetPrice(bar, y, (p) => this.host.priceToY(pane, p), magnet);
        if (snapped !== null) price = snapped;
      }
    }
    return { time: map.timeOf(index), price };
  }

  /** A point placed or dragged: Shift keeps it at 45° steps from `other`, else the magnet. */
  private anchorAt(input: PointerInput, other?: DrawingPoint): DrawingPoint | null {
    if (input.shift && other) {
      const ox = this.timeToX(other.time);
      const oy = this.host.priceToY(input.pane, other.price);
      const logical = this.host.xToLogical(input.x);
      if (ox !== null && oy !== null && logical !== null) {
        const bx = this.host.logicalToX(Math.round(logical)) ?? input.x;
        const to = snap45({ x: ox, y: oy }, { x: bx, y: input.y });
        // Shift's line is exact: the magnet stays out of it.
        return this.pointAt(input.pane, to.x, to.y, null);
      }
    }
    const { magnetOn, magnet } = this.settings;
    // Ctrl (⌘) turns the magnet off while it's on, and on while it's off.
    const on = input.mod ? !magnetOn : magnetOn;
    return this.pointAt(input.pane, input.x, input.y, on ? magnet : null);
  }

  private press(tool: DrawingTool, input: PointerInput, key: string | null): void {
    const placing = this.placing;
    if (placing) {
      // The last point's click: the drawing is done when it's let go.
      if (input.pane === placing.pane) this.movePlacing(input);
      placing.pressed = true;
      placing.closing = true;
      return;
    }
    const point = this.anchorAt(input);
    if (!point) return;
    this.placing = {
      tool,
      pane: input.pane,
      key,
      points: Array.from({ length: TOOL_POINTS[tool] }, () => ({ ...point })),
      pressed: true,
      downAt: { x: input.x, y: input.y },
      dragged: false,
      closing: false,
    };
  }

  private movePlacing(input: PointerInput): void {
    const placing = this.placing;
    if (!placing) return;
    const last = placing.points.length - 1;
    const other = last > 0 ? placing.points[0] : undefined;
    const point = this.anchorAt(input, other);
    if (point) placing.points[last] = point;
    if (
      placing.pressed &&
      Math.hypot(input.x - placing.downAt.x, input.y - placing.downAt.y) >= DRAG_START
    ) {
      placing.dragged = true;
    }
  }

  private finishPlacing(): void {
    const placing = this.placing;
    if (!placing) return;
    this.stopPlacing();
    const [a, b] = placing.points;
    // Two points in one place make no line to see or take: nothing is drawn.
    const degenerate =
      b !== undefined && a !== undefined && a.time === b.time && a.price === b.price;
    if (!degenerate) {
      const drawing = newDrawing(this.newId(), placing.tool, placing.points, placing.key);
      this.edit([...this.drawings, drawing]);
      this.setSelection([drawing.id]);
    }
    if (!this.settings.keepDrawing) this.events.onToolDone?.();
  }

  private stopPlacing(): void {
    this.placing = null;
    this.resume();
  }

  private moveDrag(input: PointerInput): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moved && Math.hypot(input.x - drag.start.x, input.y - drag.start.y) < DRAG_START) {
      return;
    }
    drag.moved = true;
    const base = drag.original;
    // A horizontal line has only a price; a vertical line moves only in time.
    const priceOnly = base.tool === 'horizontal-line';
    const timeOnly = base.tool === 'vertical-line';
    if (drag.handle !== null) {
      if (input.pane !== drag.pane) return;
      const points = base.points.map((point) => ({ ...point }));
      const other = points.length === 2 ? points[1 - drag.handle] : undefined;
      const point = this.anchorAt(input, other);
      const was = points[drag.handle];
      if (!point || !was) return;
      points[drag.handle] = {
        time: priceOnly ? was.time : point.time,
        price: timeOnly ? was.price : point.price,
      };
      drag.current = { ...base, points };
    } else {
      const logical = this.host.xToLogical(input.x);
      if (logical === null || drag.startLogical === null) return;
      const bars = priceOnly ? 0 : Math.round(logical - drag.startLogical);
      // Up and down by the pointer's own pixels, so a log scale moves it as the eye expects;
      // from another pane (a vertical line crossing it) only in time.
      const own = this.host.paneIndex(base.pane) === drag.pane;
      const dy = own && !timeOnly ? input.y - drag.start.y : 0;
      const map = this.timeMap();
      const points: DrawingPoint[] = [];
      for (const point of base.points) {
        const y = this.host.priceToY(drag.pane, point.price);
        const price = dy !== 0 && y !== null ? this.host.yToPrice(drag.pane, y + dy) : point.price;
        if (price === null) return;
        const time = bars === 0 ? point.time : map.timeOf(map.logicalOf(point.time) + bars);
        points.push({ time, price });
      }
      drag.current = { ...base, id: drag.cloneId ?? base.id, points };
    }
    this.update();
  }

  private endDrag(): void {
    this.drag = null;
    this.resume();
  }

  private suspend(): void {
    if (this.panningOff) return;
    this.panningOff = true;
    this.host.setPanning(false);
  }

  private resume(): void {
    if (!this.panningOff || this.placing || this.drag) return;
    this.panningOff = false;
    this.host.setPanning(true);
  }

  private update(): void {
    this.updateCursor();
    this.host.requestUpdate();
  }

  /**
   * The cursor: a crosshair while drawing, a pointer over a drawing, and otherwise the cursor
   * mode's (provisional, §11).
   */
  private updateCursor(): void {
    const { tool, cursor } = this.settings;
    let next: string | null;
    if (tool || this.placing) next = 'crosshair';
    else if (this.drag || this.hover) next = cursor === 'eraser' ? 'eraser' : 'pointer';
    else next = cursor === 'cross' ? 'crosshair' : cursor === 'arrow' ? 'default' : cursor;
    if (next === this.cursor) return;
    this.cursor = next;
    this.host.setCursor(next);
  }
}
