import {
  type Bar,
  type Drawing,
  type DrawingPoint,
  type DrawingStyle,
  type DrawingTool,
  defaultDrawingStyle,
  isPitchforkTool,
  newDrawing,
  newDrawingId,
  type Resolution,
  styleWithoutText,
  TOOL_POINTS,
  visibleOn,
} from '@tradingnerd/core';
import {
  disjointChannel,
  dragChannelHandle,
  flatTopBottom,
  parallelChannel,
  placedPoints,
} from './channels';
import {
  distanceToSegment,
  HANDLE_HIT,
  insidePolygon,
  insideRect,
  LINE_HIT,
  lineSegment,
  type Pt,
  type Rect,
  rectOf,
  type Size,
  segmentTouchesRect,
  snap45,
} from './geometry';
import { type MagnetMode, magnetPrice } from './magnet';
import type { FillArea, LookLine, PartLabel, ShapeParts, TextFrame } from './parts';
import { pitchfork } from './pitchforks';
import { barRange, fitRegression, type RegressionFit, regressionParts } from './regression';
import { TimeMap } from './timeMap';

/**
 * The user's drawings on the chart (docs/SPEC.md §6.24, milestones D1 to D3a): which are drawn on
 * each pane and where, the pointer's work on them (placing a tool's points, selecting one or
 * several, dragging a point or every drawing selected, Shift's 45° and its straight moves, Ctrl/⌘
 * + click to add to the selection, Ctrl/⌘ + drag to clone or to draw a box that selects, the
 * eraser), the arrow keys' moves, a right-click's drawing, and the toolbar's modes (magnet, keep
 * drawing, lock and hide all). The app keeps the drawings (per symbol, saved, with undo); the
 * engine tells it of each edit and is given the new list back. A new drawing, and the one being
 * placed, take the style the app gives its tool: the last one given a drawing of it (D3b).
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
  /** Load about this many bars of history older than the chart's first (a regression's). */
  needHistory?(bars: number): void;
  /** The chart has every bar there is: its first is the start of the exchange's history. */
  historyEnded?(): boolean;
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
  /** A drawing was right-clicked, at this place in the window: its menu opens (D3a). */
  onMenu?(id: string, clientX: number, clientY: number): void;
  /** A new drawing's id. */
  newId?(): string;
  /**
   * The style a new drawing of a tool starts with: the last one given a drawing of it (D3b), its
   * text left out; its tool's defaults when there's none.
   */
  styleOf?(tool: DrawingTool): DrawingStyle | undefined;
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

/** A place a selected drawing marks on the price and time axes, with its price and time. */
export interface AxisPoint {
  x: number | null;
  y: number | null;
  price: number;
  time: number;
}

/** A drawing as shown on one pane. */
export interface PlacedShape {
  drawing: Drawing;
  /** Its points on this pane, in order; null where one can't be placed (no bars). */
  points: (Pt | null)[];
  /** The line between a line tool's two points, for its text and stats; null for the rest. */
  segment: [Pt, Pt] | null;
  /** Its lines as drawn in its own look, carried to the pane's edges where they extend. */
  lines: [Pt, Pt][];
  /** Lines with a look of their own: a channel's or pitchfork's levels, a regression's bands. */
  looks: LookLine[];
  /** Its filled areas, under its lines. */
  fills: FillArea[];
  /** A press inside its fills takes it (a channel's background). */
  fillsTakeClicks: boolean;
  /** Ends with an arrow: its tip, and the point it points away from. */
  arrows: [Pt, Pt][];
  handles: Handle[];
  /** Where a channel's text goes. */
  frame: TextFrame | null;
  /** A text it writes beside itself (a regression's Pearson's R). */
  label: PartLabel | null;
  /** What it marks on the axes while selected, or always with its price labels on. */
  axis: AxisPoint[];
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
/**
 * A regression trend asks for older history until the chart holds its first bar, but never past
 * this many bars on the chart: beyond, it isn't worked out on that interval (ours, provisional
 * §11; 35 days of 1-minute bars, 137 years of days).
 */
export const REGRESSION_HISTORY_BARS = 50_000;

interface Placing {
  tool: DrawingTool;
  pane: number;
  key: string | null;
  points: DrawingPoint[];
  /** The point the pointer places now: 1 once the first is down, up to the last. */
  index: number;
  /** The pointer is down. */
  pressed: boolean;
  downAt: Pt;
  dragged: boolean;
  /** A press placed the point before the last: it's set when the press is let go. */
  advancing: boolean;
  /** The last point's press has come: the drawing is done when it's let go. */
  closing: boolean;
}

interface Drag {
  /** The drawing pressed. */
  id: string;
  /** The point being dragged, or null for the whole drawing (and those selected with it). */
  handle: number | null;
  pane: number;
  start: PointerInput;
  startLogical: number | null;
  /** The drawings a drag moves, as they were at the press: none when the one pressed is locked. */
  originals: Drawing[];
  /** The same drawings as the drag has them now; copies with ids of their own while cloning. */
  current: Drawing[];
  /** Ctrl/⌘ at the press on a drawing's body: a drag moves copies, the drawings stay. */
  clone: boolean;
  /** The copies' ids, by their originals', once a cloning drag starts. */
  cloneIds: Map<string, string> | null;
  /**
   * What a click (a press let go without moving) does to the selection: Ctrl/⌘ adds the drawing
   * or takes it out; a plain click on one of several selected selects it alone.
   */
  click: 'toggle' | 'only' | null;
  moved: boolean;
}

/** Ctrl/⌘ + drag over no drawing: a box, on the pane it started on, selecting what it touches. */
interface Box {
  pane: number;
  from: Pt;
  to: Pt;
}

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
  private box: Box | null = null;
  private map: TimeMap | null = null;
  private panningOff = false;
  private cursor: string | null | undefined = undefined;
  /** Each pane's shapes as last worked out, and what they were worked out from. */
  private shapeCache = new Map<
    number,
    {
      version: number;
      stamp: string;
      bars: readonly Bar[];
      length: number;
      last: Bar | undefined;
      shapes: PlacedShape[];
    }
  >();
  /** Counts the engine's changes: each repaint it asks for. */
  private version = 0;
  /** Regressions worked out on these bars, by their range and inputs. */
  private fits = new Map<string, RegressionFit | null>();
  private fitsOn: { bars: readonly Bar[]; length: number; last: Bar | undefined } | null = null;

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
    // A hidden drawing isn't on the chart: it leaves the selection (D3c).
    const shown = this.selectable();
    const kept = this.selected.filter((id) => shown.has(id));
    if (kept.length !== this.selected.length) this.setSelection(kept);
    if (this.hover && !ids.has(this.hover)) this.setHover(null, null);
    this.askHistory();
    this.update();
  }

  current(): readonly Drawing[] {
    return this.drawings;
  }

  setSettings(settings: Partial<DrawingSettings>): void {
    const before = this.settings;
    this.settings = { ...before, ...settings };
    if (this.placing && this.settings.tool !== this.placing.tool) this.stopPlacing();
    if (this.settings.hideAll && !before.hideAll) {
      this.box = null;
      this.setSelection([]);
    }
    if (this.settings.tool) this.setHover(null, null);
    this.update();
  }

  drawingSettings(): Readonly<DrawingSettings> {
    return this.settings;
  }

  /** The bars or their interval changed: anchor times map to new places. */
  barsChanged(): void {
    this.map = null;
    this.version++;
    this.askHistory();
    this.host.requestUpdate();
  }

  selection(): readonly string[] {
    return this.selected;
  }

  select(ids: readonly string[]): void {
    const known = this.selectable();
    this.setSelection(ids.filter((id) => known.has(id)));
    this.update();
  }

  /** The drawings that can be selected: every one but the hidden (D3c). */
  private selectable(): Set<string> {
    return new Set(this.drawings.filter((drawing) => !drawing.hidden).map((drawing) => drawing.id));
  }

  /** The pane a drawing being placed or dragged, or a box, is on: the pointer's moves are read there. */
  activePane(): number | null {
    return this.placing?.pane ?? this.drag?.pane ?? this.box?.pane ?? null;
  }

  /**
   * Escape: a drawing being placed or dragged is let go, else the selection, else the tool.
   * True when it did something.
   */
  cancel(): boolean {
    if (this.box) {
      this.box = null;
      this.resume();
      this.update();
      return true;
    }
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

  /**
   * The arrow keys with drawings selected (Charting Library shortcuts: "Move selected drawing
   * left", "right", "up", "down"): each unlocked one moved by `bars` and `dy` px of its own pane,
   * as a drag moves it (ours: a bar and a pixel a press, provisional §11). True while any drawing
   * is selected, so the keys don't scroll the chart under it.
   */
  nudge(bars: number, dy: number): boolean {
    if (this.selected.length === 0 || this.settings.hideAll) return false;
    if (this.placing || this.drag || this.box || this.settings.lockAll) return true;
    const chosen = new Set(this.selected);
    let changed = false;
    const next = this.drawings.map((drawing) => {
      if (!chosen.has(drawing.id) || drawing.locked) return drawing;
      const moved = this.movedBy(drawing, bars, dy);
      if (!moved || moved === drawing) return drawing;
      changed = true;
      return moved;
    });
    if (changed) this.edit(next);
    return true;
  }

  /**
   * A right-click: the drawing under it, which it selects unless it's one of those selected, or
   * null where there's none, or while a tool or a drag has the pointer.
   */
  contextAt(input: PointerInput): string | null {
    // A Mac's Ctrl + click is its right-click: the press it began, still unmoved, is let go.
    if (this.drag && !this.drag.moved) this.endDrag();
    const box = this.box;
    if (box && box.from.x === box.to.x && box.from.y === box.to.y) {
      this.box = null;
      this.resume();
    }
    if (this.placing || this.drag || this.box || this.settings.tool) return null;
    if (this.host.paneKey(input.pane) === undefined) return null;
    const hit = this.hitTest(input.pane, input.x, input.y);
    if (!hit) return null;
    if (!this.selected.includes(hit.id)) this.setSelection([hit.id]);
    this.update();
    return hit.id;
  }

  /** The box Ctrl/⌘ + drag is drawing on a pane, or null. */
  selectionBox(pane: number): Rect | null {
    const box = this.box;
    return box && box.pane === pane ? rectOf(box.from, box.to) : null;
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
      // Ctrl/⌘ + drag over the chart draws a box that selects what it touches (Help Center,
      // Selecting several objects at once); a plain press lets the selection go.
      if (input.mod && cursor !== 'eraser' && !this.settings.hideAll) {
        const at = { x: input.x, y: input.y };
        this.box = { pane: input.pane, from: at, to: at };
        this.suspend();
        this.update();
        return true;
      }
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
    const body = hit.handle === null;
    const among = this.selected.includes(drawing.id);
    // Ctrl/⌘ on a drawing's body: a click adds it to the selection or takes it out, a drag clones
    // it, or every drawing selected with it (Help Center, How to clone drawings: "Multiselected
    // drawings can be copied as well").
    const adding = input.mod && body;
    // A plain press on one of several selected moves them all; let go unmoved, it's selected alone.
    const group = body && among && this.selected.length > 1;
    if (!adding && !group) this.setSelection([drawing.id]);
    this.suspend();
    const movable = (item: Drawing) => !item.locked && !this.settings.lockAll;
    const moving = fixed
      ? []
      : (adding || group) && among
        ? this.selectedDrawings().filter(movable)
        : [drawing];
    this.drag = {
      id: drawing.id,
      handle: hit.handle,
      pane: input.pane,
      start: input,
      startLogical: this.host.xToLogical(input.x),
      originals: moving,
      current: moving,
      clone: adding,
      cloneIds: null,
      click: adding ? 'toggle' : group ? 'only' : null,
      moved: false,
    };
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
    const box = this.box;
    if (box) {
      if (pressed && input && input.pane === box.pane) {
        // Kept on its pane, however far the pointer goes.
        const size = this.host.paneSize(box.pane);
        box.to = size
          ? {
              x: Math.min(size.width, Math.max(0, input.x)),
              y: Math.min(size.height, Math.max(0, input.y)),
            }
          : { x: input.x, y: input.y };
        this.update();
      }
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
      const last = placing.points.length - 1;
      if (last === 0 || placing.closing) {
        this.finishPlacing();
      } else if (placing.dragged || placing.advancing) {
        // A drag or a click set the point being placed: the drawing is done, or its next point
        // follows the pointer (a three-point tool's third, after a drag drew its first line).
        if (placing.index >= last) {
          this.finishPlacing();
        } else {
          placing.index += 1;
          placing.points[placing.index] = {
            ...(placing.points[placing.index - 1] as DrawingPoint),
          };
          placing.dragged = false;
          placing.advancing = false;
        }
      }
      this.update();
      return;
    }
    const box = this.box;
    if (box) {
      this.box = null;
      // What it touched joins the selection, in drawing order.
      const touched = new Set([...this.selected, ...this.boxHits(box)]);
      this.setSelection(
        this.drawings.filter((drawing) => touched.has(drawing.id)).map((drawing) => drawing.id),
      );
      this.resume();
      this.update();
      return;
    }
    const drag = this.drag;
    if (drag) {
      this.endDrag();
      if (drag.moved && drag.current.length > 0) {
        if (drag.cloneIds) {
          this.edit([...this.drawings, ...drag.current]);
          this.setSelection(drag.current.map((drawing) => drawing.id));
        } else {
          const moved = new Map(drag.current.map((drawing) => [drawing.id, drawing]));
          this.edit(this.drawings.map((item) => moved.get(item.id) ?? item));
        }
      } else if (!drag.moved && drag.click === 'toggle') {
        const toggled = this.selected.includes(drag.id)
          ? this.selected.filter((id) => id !== drag.id)
          : this.drawings
              .filter((item) => item.id === drag.id || this.selected.includes(item.id))
              .map((item) => item.id);
        this.setSelection(toggled);
      } else if (!drag.moved && drag.click === 'only') {
        this.setSelection([drag.id]);
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
    // A paint asks three times (the pane, the price axis, the time axis): worked out once while
    // nothing they depend on has changed, the chart's view included (two bars' x and two prices'
    // y fix where every point goes, on a log scale too), its interval (the Visibility tab) and its
    // last bar (a live regression).
    const bars = this.host.bars();
    const resolution = this.host.resolution();
    const stamp = [
      key,
      resolution ? `${resolution.count}${resolution.unit}` : '',
      size.width,
      size.height,
      this.host.logicalToX(0),
      this.host.logicalToX(1),
      this.host.priceToY(pane, 1),
      this.host.priceToY(pane, 2),
    ].join('|');
    const cached = this.shapeCache.get(pane);
    if (
      cached &&
      cached.version === this.version &&
      cached.stamp === stamp &&
      cached.bars === bars &&
      cached.length === bars.length &&
      cached.last === bars[bars.length - 1]
    ) {
      return cached.shapes;
    }
    const shapes: PlacedShape[] = [];
    for (const drawing of this.shown()) {
      const own = drawing.pane === key;
      // A vertical line crosses every pane (the capture's extendLine), its handle on its own.
      const across = drawing.tool === 'vertical-line' || drawing.tool === 'cross-line';
      if (!own && !(across && this.host.paneIndex(drawing.pane) !== null)) continue;
      const shape = this.shapeOf(drawing, pane, size, own);
      if (shape) shapes.push(shape);
    }
    this.shapeCache.set(pane, {
      version: this.version,
      stamp,
      bars,
      length: bars.length,
      last: bars[bars.length - 1],
      shapes,
    });
    return shapes;
  }

  /** The drawings being moved or placed now, or null: every other one stays still meanwhile. */
  activeIds(): ReadonlySet<string> | null {
    if (this.placing) return new Set([PREVIEW_ID]);
    const drag = this.drag;
    if (drag?.moved && drag.current.length > 0) {
      return new Set(drag.current.map((drawing) => drawing.id));
    }
    return null;
  }

  /** Shown selected: its handles with the thicker ring (the drawing being placed is too). */
  isSelected(id: string): boolean {
    if (this.selected.includes(id) || id === PREVIEW_ID) return true;
    const clones = this.drag?.cloneIds;
    return clones ? this.drag?.current.some((drawing) => drawing.id === id) === true : false;
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
    // Then the topmost drawing under the pointer: on one of its lines, or inside a channel's
    // background (TradingView's channels take a click there; a pitchfork's and a regression's
    // wide bands don't, so the chart under them can still be dragged; provisional, §11).
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i] as PlacedShape;
      const reach = LINE_HIT + shape.drawing.style.width / 2;
      const onLine =
        shape.lines.some(([a, b]) => distanceToSegment(at, a, b) <= reach) ||
        shape.looks.some(
          (look) => distanceToSegment(at, look.a, look.b) <= LINE_HIT + look.width / 2,
        );
      const inside =
        shape.fillsTakeClicks && shape.fills.some((fill) => insidePolygon(at, fill.points));
      if (onLine || inside) return { id: shape.drawing.id, handle: null };
    }
    return null;
  }

  debug(): {
    drawings: Drawing[];
    selection: string[];
    placing: { tool: DrawingTool; points: DrawingPoint[]; index: number } | null;
    dragging: string | null;
    box: Rect | null;
    hover: string | null;
    cursor: string | null;
    settings: DrawingSettings;
  } {
    return {
      drawings: this.drawings.slice(),
      selection: this.selected.slice(),
      placing: this.placing
        ? {
            tool: this.placing.tool,
            points: this.placing.points.map((p) => ({ ...p })),
            index: this.placing.index,
          }
        : null,
      dragging: this.drag?.id ?? null,
      box: this.box ? rectOf(this.box.from, this.box.to) : null,
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
    return this.events.newId?.() ?? newDrawingId();
  }

  /** A new drawing of a tool, in the style the app gives it (its last, D3b) or its defaults. */
  private newOf(
    id: string,
    tool: DrawingTool,
    points: DrawingPoint[],
    key: string | null,
  ): Drawing {
    const drawing = newDrawing(id, tool, points, key);
    const style = this.events.styleOf?.(tool);
    return style ? { ...drawing, style: styleWithoutText(style) } : drawing;
  }

  /** The drawings selected, in drawing order. */
  private selectedDrawings(): Drawing[] {
    const chosen = new Set(this.selected);
    return this.drawings.filter((drawing) => chosen.has(drawing.id));
  }

  /** The drawings a box touches on its pane: a line through it, a handle in it, or inside a fill. */
  private boxHits(box: Box): string[] {
    const rect = rectOf(box.from, box.to);
    // A Ctrl/⌘ + click on no drawing selects nothing more.
    if (rect.right - rect.left < DRAG_START && rect.bottom - rect.top < DRAG_START) return [];
    const corners = [
      { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom },
      { x: rect.left, y: rect.bottom },
    ];
    const touches = (shape: PlacedShape) =>
      shape.lines.some(([a, b]) => segmentTouchesRect(a, b, rect)) ||
      shape.looks.some((look) => segmentTouchesRect(look.a, look.b, rect)) ||
      shape.handles.some((handle) => insideRect(handle, rect)) ||
      (shape.fillsTakeClicks &&
        shape.fills.some((fill) => corners.some((corner) => insidePolygon(corner, fill.points))));
    return this.shapes(box.pane)
      .filter((shape) => shape.drawing.id !== PREVIEW_ID && touches(shape))
      .map((shape) => shape.drawing.id);
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
    if (drag?.moved && drag.current.length > 0) {
      if (drag.cloneIds) {
        shown = [...list, ...drag.current];
      } else {
        const moved = new Map(drag.current.map((drawing) => [drawing.id, drawing]));
        shown = list.map((item) => moved.get(item.id) ?? item);
      }
    }
    if (this.placing) {
      shown = [...shown, this.preview(this.placing)];
    }
    return shown;
  }

  /**
   * The drawing being placed, as it would be: a three-point tool shows only its first line, in
   * its look, until its second point is down (the third would only echo the second; ours).
   */
  private preview(placing: Placing): Drawing {
    const { tool, points, key, index } = placing;
    if (index >= points.length - 1) return this.newOf(PREVIEW_ID, tool, points, key);
    const first = newDrawing(PREVIEW_ID, 'trend-line', points.slice(0, 2), key);
    const look = this.events.styleOf?.(tool) ?? defaultDrawingStyle(tool);
    first.style.color = look.color;
    first.style.width = look.width;
    first.style.lineStyle = look.lineStyle;
    return first;
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
      looks: [],
      fills: [],
      fillsTakeClicks: false,
      arrows: [],
      handles: [],
      frame: null,
      label: null,
      axis: drawing.points.map((point, i) => ({
        x: points[i]?.x ?? null,
        y: own ? (points[i]?.y ?? null) : null,
        price: point.price,
        time: point.time,
      })),
      own,
      pane,
      size,
    };
    if (TOOL_POINTS[drawing.tool] === 3 || drawing.tool === 'regression-trend') {
      return own ? this.partsShape(shape) : null;
    }
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

  /** A channel's, pitchfork's or regression trend's shape on its own pane. */
  private partsShape(shape: PlacedShape): PlacedShape | null {
    const { drawing, size } = shape;
    if (drawing.tool === 'regression-trend') return this.regressionShape(shape);
    if (shape.points.some((point) => point === null)) return null;
    const points = shape.points as Pt[];
    const { style } = drawing;
    let parts: ShapeParts | null = null;
    switch (drawing.tool) {
      case 'parallel-channel':
        parts = parallelChannel(points, style, size);
        break;
      case 'flat-top-bottom':
        parts = flatTopBottom(points, style, size);
        break;
      case 'disjoint-channel':
        parts = disjointChannel(points, style, size);
        break;
      default:
        if (isPitchforkTool(drawing.tool)) parts = pitchfork(drawing.tool, points, style, size);
    }
    if (!parts) return null;
    this.takeParts(shape, parts);
    shape.axis = this.axisOf(shape, parts);
    // A flat top/bottom's and disjoint channel's ends: arrows on both lines where they stop.
    if (drawing.tool === 'flat-top-bottom' || drawing.tool === 'disjoint-channel') {
      const handle = (n: number) => parts.handles.find((item) => item.point === n);
      const flat = drawing.tool === 'flat-top-bottom';
      const start = handle(flat ? 2 : 3);
      const end = handle(flat ? 3 : 2);
      const [a, b] = points;
      for (const [from, to] of [
        [a, b],
        [start, end],
      ]) {
        if (!from || !to) continue;
        if (style.leftEnd === 'arrow' && !style.extendLeft) shape.arrows.push([from, to]);
        if (style.rightEnd === 'arrow' && !style.extendRight) shape.arrows.push([to, from]);
      }
    }
    return shape;
  }

  private takeParts(shape: PlacedShape, parts: ShapeParts): void {
    shape.lines = parts.lines;
    shape.looks = parts.looks;
    shape.fills = parts.fills;
    shape.fillsTakeClicks = parts.fillsTakeClicks;
    shape.handles = parts.handles;
    shape.frame = parts.frame;
    shape.label = parts.label ?? null;
  }

  /**
   * What a channel or pitchfork marks on the axes: its corners (a pitchfork its three points),
   * each with its price and its bar's time.
   */
  private axisOf(shape: PlacedShape, parts: ShapeParts): AxisPoint[] {
    const { drawing, pane } = shape;
    const [p0, p1, p2] = drawing.points;
    if (!p0 || !p1 || !p2) return [];
    const entry = (n: number, time: number, price?: number): AxisPoint | null => {
      const handle = parts.handles.find((item) => item.point === n);
      if (!handle) return null;
      const value = price ?? this.host.yToPrice(pane, handle.y);
      return value === null ? null : { x: handle.x, y: handle.y, price: value, time };
    };
    const corners =
      drawing.tool === 'parallel-channel'
        ? [entry(2, p0.time), entry(3, p1.time)]
        : drawing.tool === 'flat-top-bottom'
          ? [entry(2, p0.time, p2.price), entry(3, p1.time, p2.price)]
          : drawing.tool === 'disjoint-channel'
            ? [entry(2, p1.time, p2.price), entry(3, p0.time)]
            : [entry(2, p2.time, p2.price)];
    return [entry(0, p0.time, p0.price), entry(1, p1.time, p1.price), ...corners].filter(
      (item): item is AxisPoint => item !== null,
    );
  }

  /**
   * A regression trend: worked out from the chart's bars between its points, or, until it can be
   * (fewer than two bars there, or older history still on its way), a line between its points in
   * its base line's look, never one worked out from part of its bars.
   */
  private regressionShape(shape: PlacedShape): PlacedShape | null {
    const { drawing, pane, size } = shape;
    const [p0, p1] = drawing.points;
    if (!p0 || !p1) return null;
    const fit = this.regressionFit(drawing);
    const parts = fit
      ? regressionParts(
          fit,
          (index) => this.host.logicalToX(index),
          (price) => this.host.priceToY(pane, price),
          drawing.style,
          size,
          p0.time <= p1.time ? [0, 1] : [1, 0],
        )
      : null;
    if (fit && parts) {
      this.takeParts(shape, parts);
      const { times } = this.timeMap();
      const [first, last] = parts.handles;
      shape.axis =
        first && last
          ? [
              { x: first.x, y: first.y, price: fit.start, time: times[fit.from] as number },
              { x: last.x, y: last.y, price: fit.end, time: times[fit.to] as number },
            ]
          : [];
      return shape;
    }
    const [a, b] = shape.points;
    if (!a || !b) return null;
    const line = lineSegment(a, b, false, false, size);
    if (line) shape.lines.push(line);
    shape.handles.push({ ...a, point: 0, square: false }, { ...b, point: 1, square: false });
    return shape;
  }

  /** A regression trend's fit on the chart's bars, kept until the bars change. */
  private regressionFit(drawing: Drawing): RegressionFit | null {
    const [p0, p1] = drawing.points;
    const map = this.timeMap();
    const first = map.times[0];
    if (!p0 || !p1 || first === undefined) return null;
    // Every bar of its range must be on the chart, unless the exchange has none older.
    if (Math.min(p0.time, p1.time) < first && !(this.host.historyEnded?.() ?? false)) return null;
    const range = barRange(map.times, p0.time, p1.time);
    if (!range) return null;
    const bars = this.host.bars();
    const last = bars[bars.length - 1];
    const on = this.fitsOn;
    if (!on || on.bars !== bars || on.length !== bars.length || on.last !== last) {
      this.fits.clear();
      this.fitsOn = { bars, length: bars.length, last };
    }
    const inputs = drawing.style.regression;
    const key = [
      range[0],
      range[1],
      inputs.source,
      inputs.upperDeviation,
      inputs.lowerDeviation,
      inputs.useUpperDeviation,
      inputs.useLowerDeviation,
    ].join('|');
    if (!this.fits.has(key)) {
      if (this.fits.size >= 256) this.fits.clear();
      this.fits.set(key, fitRegression(bars, range[0], range[1], inputs));
    }
    return this.fits.get(key) ?? null;
  }

  /**
   * The history a regression trend shown on this interval needs: the chart is asked for the bars
   * between its first point and the chart's first bar, up to REGRESSION_HISTORY_BARS in all.
   */
  private askHistory(): void {
    const need = this.host.needHistory;
    if (!need || this.settings.hideAll || this.host.historyEnded?.()) return;
    const map = this.timeMap();
    const first = map.times[0];
    if (first === undefined) return;
    const resolution = this.host.resolution();
    let earliest = Number.POSITIVE_INFINITY;
    for (const drawing of this.drawings) {
      if (drawing.tool !== 'regression-trend' || drawing.hidden) continue;
      if (resolution && !visibleOn(drawing.visibility, resolution)) continue;
      for (const point of drawing.points) earliest = Math.min(earliest, point.time);
    }
    if (!(earliest < first)) return;
    const lacking = Math.ceil(-map.logicalOf(earliest));
    if (lacking <= 0 || map.length + lacking > REGRESSION_HISTORY_BARS) return;
    need.call(this.host, lacking);
  }

  /** Points as bars (x, the logical index) and the pane's y, where channels.ts's rules work. */
  private toLogical(pane: number, points: readonly DrawingPoint[]): Pt[] | null {
    const map = this.timeMap();
    const out: Pt[] = [];
    for (const point of points) {
      const x = map.logicalOf(point.time);
      const y = this.host.priceToY(pane, point.price);
      if (!Number.isFinite(x) || y === null) return null;
      out.push({ x, y });
    }
    return out;
  }

  /**
   * Points as bars and pane y back as times and prices. One that sits on a known point's bar, or
   * at its y, keeps that point's time or price, so a point a rule left alone comes back as it was.
   */
  private fromLogical(
    pane: number,
    points: readonly Pt[],
    known: readonly DrawingPoint[],
    knownAt: readonly Pt[],
  ): DrawingPoint[] | null {
    const map = this.timeMap();
    const out: DrawingPoint[] = [];
    for (const point of points) {
      const sameX = knownAt.findIndex((item) => item.x === point.x);
      const sameY = knownAt.findIndex((item) => item.y === point.y);
      const time = sameX >= 0 ? (known[sameX] as DrawingPoint).time : map.timeOf(point.x);
      const price =
        sameY >= 0 ? (known[sameY] as DrawingPoint).price : this.host.yToPrice(pane, point.y);
      if (price === null || !Number.isFinite(time)) return null;
      out.push({ time, price });
    }
    return out;
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
      // The point being placed goes where the press is. The last one's: the drawing is done when
      // it's let go; an earlier one's: the next point follows the pointer then.
      if (input.pane === placing.pane) this.movePlacing(input);
      placing.pressed = true;
      placing.downAt = { x: input.x, y: input.y };
      placing.dragged = false;
      if (placing.index >= placing.points.length - 1) placing.closing = true;
      else placing.advancing = true;
      return;
    }
    // A regression trend is worked out from the symbol's prices: only on the price pane (ours;
    // TradingView doesn't say, §11).
    if (tool === 'regression-trend' && key !== null) return;
    const point = this.anchorAt(input);
    if (!point) return;
    const count = TOOL_POINTS[tool];
    this.placing = {
      tool,
      pane: input.pane,
      key,
      points: Array.from({ length: count }, () => ({ ...point })),
      index: Math.min(1, count - 1),
      pressed: true,
      downAt: { x: input.x, y: input.y },
      dragged: false,
      advancing: false,
      closing: false,
    };
  }

  private movePlacing(input: PointerInput): void {
    const placing = this.placing;
    if (!placing) return;
    const { index, points } = placing;
    // Shift keeps the second point at 45° steps from the first.
    const other = index === 1 ? points[0] : undefined;
    const point = this.anchorAt(input, other);
    if (point) {
      points[index] = point;
      // The points after it wait on it (a three-point tool's third while its second is placed).
      for (let i = index + 1; i < points.length; i++) points[i] = { ...point };
    }
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
    const points = this.placedOf(placing);
    if (!degenerate(placing.tool, points)) {
      const drawing = this.newOf(this.newId(), placing.tool, points, placing.key);
      this.edit([...this.drawings, drawing]);
      this.setSelection([drawing.id]);
    }
    if (!this.settings.keepDrawing) this.events.onToolDone?.();
  }

  /** A drawing's points as kept once placed: a channel's third as its first two set it. */
  private placedOf(placing: Placing): DrawingPoint[] {
    const { tool, points, pane } = placing;
    if (points.length < 3) return points;
    const at = this.toLogical(pane, points);
    if (!at) return points;
    return this.fromLogical(pane, placedPoints(tool, at), points, at) ?? points;
  }

  private stopPlacing(): void {
    this.placing = null;
    this.resume();
  }

  private moveDrag(input: PointerInput): void {
    const drag = this.drag;
    if (!drag || drag.originals.length === 0) return;
    if (!drag.moved && Math.hypot(input.x - drag.start.x, input.y - drag.start.y) < DRAG_START) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      // Cloning: the copies get their ids as the drag starts, the originals stay where they are.
      if (drag.clone) {
        drag.cloneIds = new Map(drag.originals.map((drawing) => [drawing.id, this.newId()]));
      }
    }
    if (drag.handle !== null) {
      const base = drag.originals[0] as Drawing;
      // A horizontal line has only a price; a vertical line moves only in time.
      const priceOnly = base.tool === 'horizontal-line';
      const timeOnly = base.tool === 'vertical-line';
      if (input.pane !== drag.pane) return;
      const channel = this.dragChannel(base, drag.handle, input);
      if (channel === null) return;
      if (channel) {
        drag.current = [{ ...base, points: channel }];
        this.update();
        return;
      }
      const points = base.points.map((point) => ({ ...point }));
      const other = points.length === 2 ? points[1 - drag.handle] : undefined;
      const point = this.anchorAt(input, other);
      const was = points[drag.handle];
      if (!point || !was) return;
      points[drag.handle] = {
        time: priceOnly ? was.time : point.time,
        price: timeOnly ? was.price : point.price,
      };
      drag.current = [{ ...base, points }];
    } else {
      const logical = this.host.xToLogical(input.x);
      if (logical === null || drag.startLogical === null) return;
      let bars = Math.round(logical - drag.startLogical);
      // Up and down by the pointer's own pixels, so a log scale moves them as the eye expects.
      let dy = input.y - drag.start.y;
      // Shift holds the move to the way the pointer went further: across or up and down
      // (Charting Library shortcuts: "Move a drawing horizontally or vertically | Drag + Shift").
      if (input.shift) {
        if (Math.abs(input.x - drag.start.x) >= Math.abs(dy)) dy = 0;
        else bars = 0;
      }
      const next: Drawing[] = [];
      for (const base of drag.originals) {
        // The one pressed from another pane than its own (a vertical line crossing it) moves
        // only in time; the others selected with it by the same pixels on their own panes.
        const own = base.id !== drag.id || this.host.paneIndex(base.pane) === drag.pane;
        const moved = this.movedBy(base, bars, own ? dy : 0);
        if (!moved) return;
        const id = drag.cloneIds?.get(base.id) ?? base.id;
        next.push(id === moved.id ? moved : { ...moved, id });
      }
      drag.current = next;
    }
    this.update();
  }

  /**
   * A drawing moved by whole bars and by `dy` px of its own pane, as far as its tool moves: a
   * horizontal line only in price, a vertical line only in time. Itself when it doesn't move;
   * null when a price can't be placed now.
   */
  private movedBy(base: Drawing, bars: number, dy: number): Drawing | null {
    const across = base.tool === 'horizontal-line' ? 0 : bars;
    const pane = this.host.paneIndex(base.pane);
    const down = base.tool === 'vertical-line' || pane === null ? 0 : dy;
    if (across === 0 && down === 0) return base;
    const map = this.timeMap();
    const points: DrawingPoint[] = [];
    for (const point of base.points) {
      const y = down !== 0 && pane !== null ? this.host.priceToY(pane, point.price) : null;
      const price = y !== null && pane !== null ? this.host.yToPrice(pane, y + down) : point.price;
      if (price === null) return null;
      const time = across === 0 ? point.time : map.timeOf(map.logicalOf(point.time) + across);
      points.push({ time, price });
    }
    return { ...base, points };
  }

  /**
   * A channel's handle dragged by channels.ts's rules; undefined for a handle that moves its own
   * point (every other tool's), null when it can't be placed now.
   */
  private dragChannel(
    base: Drawing,
    handle: number,
    input: PointerInput,
  ): DrawingPoint[] | null | undefined {
    const { tool } = base;
    if (tool !== 'parallel-channel' && tool !== 'flat-top-bottom' && tool !== 'disjoint-channel') {
      return undefined;
    }
    const anchor = this.anchorAt(input);
    const at = this.toLogical(input.pane, base.points);
    const to = anchor ? this.toLogical(input.pane, [anchor])?.[0] : undefined;
    if (!anchor || !at || !to) return null;
    const next = dragChannelHandle(tool, at, handle, to);
    if (!next) return undefined;
    return this.fromLogical(input.pane, next, [...base.points, anchor], [...at, to]);
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
    if (!this.panningOff || this.placing || this.drag || this.box) return;
    this.panningOff = false;
    this.host.setPanning(true);
  }

  private update(): void {
    this.version++;
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

/**
 * Points that make nothing to see or take, so nothing is drawn: a line's two, or a channel's
 * first line's, in one place; a regression trend's on one bar; a pitchfork's three in one place.
 */
function degenerate(tool: DrawingTool, points: readonly DrawingPoint[]): boolean {
  const [a, b, c] = points;
  const same = (p?: DrawingPoint, q?: DrawingPoint) =>
    p !== undefined && q !== undefined && p.time === q.time && p.price === q.price;
  if (points.length < 2) return false;
  if (tool === 'regression-trend') return a?.time === b?.time;
  if (isPitchforkTool(tool)) return same(a, b) && same(b, c);
  return same(a, b);
}
