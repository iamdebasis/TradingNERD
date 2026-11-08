import { Args, type Call, constant, type Handler, series } from './args.ts';
import type { Compiler, Scope } from './compiler.ts';
import { PineRuntimeError, type Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import type { Compiled } from './types.ts';
import { COLORS, PineArray, PineObject, type Value } from './values.ts';

/**
 * Pine's drawings (Pine docs: Text and shapes, Lines and boxes, Tables, Polylines; the v6
 * reference's label.*, line.*, box.*, table.*, polyline.*, linefill.* and chart.point.*):
 * objects a script creates on a bar that stay on the chart until it deletes them, or until
 * there are more than the declaration allows ("scripts will only show the last 50 lines, boxes,
 * polylines, and labels on the chart by default", up to 500, polylines 100: Pine docs,
 * Limitations), when the oldest go first. A change on the live bar is undone before its next
 * update and kept by its closing one, as variables are (Runtime.record).
 *
 * Defaults the reference doesn't spell out are provisional (docs/SPEC.md §11): a label's text is
 * black, a box's fill is blue, as its border is (the manual's Lines and boxes gives the border's).
 */

export type DrawingKind = 'label' | 'line' | 'box' | 'table' | 'polyline' | 'linefill';

/** The kinds a declaration's max_*_count limits, and the most each may be set to. */
export type CountedKind = 'label' | 'line' | 'box' | 'polyline';
export const DEFAULT_DRAWING_LIMIT = 50;
export const MAX_DRAWING_LIMIT: Readonly<Record<CountedKind, number>> = {
  label: 500,
  line: 500,
  box: 500,
  polyline: 100,
};

/** How far ahead of the last bar an x by bar index may go (Pine docs, Limitations). */
const MAX_BARS_FORWARD = 500;

let nextId = 1;

export class LabelObject {
  readonly kind = 'label' as const;
  readonly id = nextId++;
  deleted = false;
  x = 0;
  y = Number.NaN;
  xloc = 'bar_index';
  yloc = 'price';
  text = '';
  tooltip = '';
  color: number = COLORS.blue as number;
  textcolor: number = COLORS.black as number;
  style = 'label_down';
  size: Value = 'normal';
  textalign = 'center';
  font = 'default';
  formatting = 0;
}

export class LineObject {
  readonly kind = 'line' as const;
  readonly id = nextId++;
  deleted = false;
  x1 = 0;
  y1 = Number.NaN;
  x2 = 0;
  y2 = Number.NaN;
  xloc = 'bar_index';
  extend = 'none';
  color: number = COLORS.blue as number;
  style = 'solid';
  width = 1;
}

export class BoxObject {
  readonly kind = 'box' as const;
  readonly id = nextId++;
  deleted = false;
  left = 0;
  top = Number.NaN;
  right = 0;
  bottom = Number.NaN;
  xloc = 'bar_index';
  extend = 'none';
  borderColor: number = COLORS.blue as number;
  borderWidth = 1;
  borderStyle = 'solid';
  bgcolor: number = COLORS.blue as number;
  text = '';
  textSize: Value = 'auto';
  textColor: number = COLORS.black as number;
  textHalign = 'center';
  textValign = 'center';
  textWrap = 'none';
  font = 'default';
  formatting = 0;
}

export interface TableCell {
  text: string;
  width: number;
  height: number;
  textColor: number;
  textHalign: string;
  textValign: string;
  textSize: Value;
  bgcolor: number;
  tooltip: string;
  font: string;
  formatting: number;
}

export class TableObject {
  readonly kind = 'table' as const;
  readonly id = nextId++;
  deleted = false;
  position = 'top_right';
  columns = 0;
  rows = 0;
  bgcolor = Number.NaN;
  frameColor = Number.NaN;
  frameWidth = 0;
  borderColor = Number.NaN;
  borderWidth = 0;
  /** Cells by row, then column; null for one never set. */
  cells: (TableCell | null)[][] = [];
  /** Merged ranges: each covers its first cell's place. */
  merges: { c0: number; r0: number; c1: number; r1: number }[] = [];
}

export class PolylineObject {
  readonly kind = 'polyline' as const;
  readonly id = nextId++;
  deleted = false;
  /** Its points as x (bar index or time, by xloc) and price, copied when it was made. */
  points: { x: number; y: number }[] = [];
  curved = false;
  closed = false;
  xloc = 'bar_index';
  lineColor: number = COLORS.blue as number;
  fillColor = Number.NaN;
  lineStyle = 'solid';
  lineWidth = 1;
}

export class LinefillObject {
  readonly kind = 'linefill' as const;
  readonly id = nextId++;
  deleted = false;
  readonly line1: LineObject;
  readonly line2: LineObject;
  color: number;
  constructor(line1: LineObject, line2: LineObject, color: number) {
    this.line1 = line1;
    this.line2 = line2;
    this.color = color;
  }
}

type AnyDrawing =
  | LabelObject
  | LineObject
  | BoxObject
  | TableObject
  | PolylineObject
  | LinefillObject;

/** What a run has drawn at its last bar, for the chart (copies: the run goes on changing its own). */
export interface DrawingSnapshot {
  labels: LabelObject[];
  lines: LineObject[];
  boxes: BoxObject[];
  tables: TableObject[];
  polylines: PolylineObject[];
  linefills: { id: number; line1: LineObject; line2: LineObject; color: number }[];
}

export const EMPTY_DRAWINGS: DrawingSnapshot = {
  labels: [],
  lines: [],
  boxes: [],
  tables: [],
  polylines: [],
  linefills: [],
};

/** A run's drawings, by kind, oldest first. */
export class DrawingStore {
  limits: Record<CountedKind, number> = {
    label: DEFAULT_DRAWING_LIMIT,
    line: DEFAULT_DRAWING_LIMIT,
    box: DEFAULT_DRAWING_LIMIT,
    polyline: DEFAULT_DRAWING_LIMIT,
  };
  readonly labels: LabelObject[] = [];
  readonly lines: LineObject[] = [];
  readonly boxes: BoxObject[] = [];
  readonly tables: TableObject[] = [];
  readonly polylines: PolylineObject[] = [];
  readonly linefills: LinefillObject[] = [];
  /** Bumped by every change, so a reader can tell when there's something new to draw. */
  version = 0;

  listOf(kind: DrawingKind): AnyDrawing[] {
    switch (kind) {
      case 'label':
        return this.labels;
      case 'line':
        return this.lines;
      case 'box':
        return this.boxes;
      case 'table':
        return this.tables;
      case 'polyline':
        return this.polylines;
      default:
        return this.linefills;
    }
  }

  /** Adds a drawing; past its kind's limit, the oldest goes (garbage collection). */
  add(rt: Runtime, item: AnyDrawing): void {
    const list = this.listOf(item.kind);
    list.push(item);
    this.version++;
    rt.record(() => {
      const i = list.lastIndexOf(item);
      if (i >= 0) list.splice(i, 1);
      this.version++;
    });
    const limit = item.kind in this.limits ? this.limits[item.kind as CountedKind] : Infinity;
    while (list.length > limit) this.remove(rt, list[0] as AnyDrawing);
  }

  remove(rt: Runtime, item: AnyDrawing): void {
    if (item.deleted) return;
    const list = this.listOf(item.kind);
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
    item.deleted = true;
    this.version++;
    rt.record(() => {
      item.deleted = false;
      if (i >= 0) list.splice(Math.min(i, list.length), 0, item);
      this.version++;
    });
    // A linefill goes with either of its lines (the v6 reference, linefill.new).
    if (item.kind === 'line') {
      for (const fill of [...this.linefills]) {
        if (fill.line1 === item || fill.line2 === item) this.remove(rt, fill);
      }
    }
  }

  /** Sets a drawing's property, undone on the live bar's next update. */
  set<T extends AnyDrawing, K extends keyof T>(rt: Runtime, item: T, key: K, value: T[K]): void {
    if (item.deleted) return;
    const old = item[key];
    if (old === value) return;
    item[key] = value;
    this.version++;
    rt.record(() => {
      item[key] = old;
      this.version++;
    });
  }

  snapshot(): DrawingSnapshot {
    const copy = <T extends object>(o: T): T =>
      Object.assign(Object.create(Object.getPrototypeOf(o)), o);
    return {
      labels: this.labels.map(copy),
      lines: this.lines.map(copy),
      boxes: this.boxes.map(copy),
      tables: this.tables.map((t) => {
        const c = copy(t);
        c.cells = t.cells.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
        c.merges = t.merges.map((m) => ({ ...m }));
        return c;
      }),
      polylines: this.polylines.map((p) => {
        const c = copy(p);
        c.points = p.points.map((pt) => ({ ...pt }));
        return c;
      }),
      linefills: this.linefills
        .filter((f) => !f.line1.deleted && !f.line2.deleted)
        .map((f) => ({ id: f.id, line1: copy(f.line1), line2: copy(f.line2), color: f.color })),
    };
  }
}

// ---- constants ----

export const LABEL_STYLES = [
  'none',
  'xcross',
  'cross',
  'triangleup',
  'triangledown',
  'flag',
  'circle',
  'arrowup',
  'arrowdown',
  'label_up',
  'label_down',
  'label_left',
  'label_right',
  'label_lower_left',
  'label_lower_right',
  'label_upper_left',
  'label_upper_right',
  'label_center',
  'square',
  'diamond',
  'text_outline',
] as const;
/** v4 wrote some label styles without the underscore (label.style_labeldown). */
const V4_LABEL_STYLES: Readonly<Record<string, string>> = {
  labelup: 'label_up',
  labeldown: 'label_down',
  labelleft: 'label_left',
  labelright: 'label_right',
  labelcenter: 'label_center',
};
export const DRAWING_LINE_STYLES = [
  'solid',
  'dotted',
  'dashed',
  'arrow_left',
  'arrow_right',
  'arrow_both',
] as const;
const EXTENDS = ['none', 'left', 'right', 'both'] as const;
const XLOCS = ['bar_index', 'bar_time'] as const;
const YLOCS = ['price', 'abovebar', 'belowbar'] as const;
export const POSITIONS = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'middle_center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
] as const;
const ALIGNS = ['left', 'center', 'right', 'top', 'bottom'] as const;
const WRAPS = ['auto', 'none'] as const;
const FONTS = ['default', 'monospace'] as const;
/** text.format_*: bold and italic add up (`text.format_bold + text.format_italic`). */
export const TEXT_FORMATS: Readonly<Record<string, number>> = { none: 0, bold: 1, italic: 2 };

const has = (list: readonly string[], member: string) => list.includes(member);

/**
 * The drawings' constants (plain text, as the v6 reference types them, but text.format_*) and
 * their *.all variables; null when the name isn't one.
 */
export function drawingName(
  c: Compiler,
  space: string,
  member: string,
  span: Span,
): Compiled | null {
  switch (space) {
    case 'label':
      if (member === 'all') return allOf(c, 'label', span);
      if (member.startsWith('style_')) {
        const style = member.slice(6);
        if (has(LABEL_STYLES, style)) return constant('string', style, span);
        const old = V4_LABEL_STYLES[style];
        if (old) return constant('string', old, span);
      }
      return null;
    case 'line':
      if (member === 'all') return allOf(c, 'line', span);
      if (member.startsWith('style_') && has(DRAWING_LINE_STYLES, member.slice(6))) {
        return constant('string', member.slice(6), span);
      }
      return null;
    case 'box':
    case 'table':
    case 'polyline':
    case 'linefill':
      return member === 'all' ? allOf(c, space, span) : null;
    case 'extend':
      return has(EXTENDS, member) ? constant('string', member, span) : null;
    case 'xloc':
      return has(XLOCS, member) ? constant('string', member, span) : null;
    case 'yloc':
      return has(YLOCS, member) ? constant('string', member, span) : null;
    case 'position':
      return has(POSITIONS, member) ? constant('string', member, span) : null;
    case 'text':
      if (member.startsWith('align_') && has(ALIGNS, member.slice(6))) {
        return constant('string', member.slice(6), span);
      }
      if (member.startsWith('wrap_') && has(WRAPS, member.slice(5))) {
        return constant('string', member.slice(5), span);
      }
      if (member.startsWith('format_') && member.slice(7) in TEXT_FORMATS) {
        return constant('int', TEXT_FORMATS[member.slice(7)] as number, span);
      }
      return null;
    case 'font':
      if (member.startsWith('family_') && has(FONTS, member.slice(7))) {
        return constant('string', member.slice(7), span);
      }
      return null;
    default:
      return null;
  }
}

/** label.all and the rest: the drawings of a kind on the chart now, oldest first. */
function allOf(c: Compiler, kind: DrawingKind, span: Span): Compiled {
  c.usesObjects();
  return series(
    `array<${kind}>`,
    (rt) => new PineArray(kind, [...rt.drawings.listOf(kind)] as unknown as Value[]),
    span,
  );
}

// ---- functions ----

type Ev<T> = (rt: Runtime) => T;
const fail = (message: string, span: Span): never => {
  throw new PineRuntimeError(message, span);
};

/** An id argument of a drawing kind: the object, or null for na. */
function idArg<T extends AnyDrawing>(
  c: Compiler,
  args: Args,
  name: string,
  kind: DrawingKind,
): Ev<T | null> {
  const value = args.get(name) as Compiled;
  c.needType(value, value.base === kind || value.base === 'na', args.fn, name, `series ${kind}`);
  const ev = value.ev;
  return (rt) => (ev(rt) as T | null) ?? null;
}

/** A chart.point argument: its time, index and price, or null for na. */
function pointArg(c: Compiler, args: Args, name: string): Ev<PineObject | null> | null {
  const value = args.get(name);
  if (!value) return null;
  c.needType(
    value,
    value.base === 'chart.point' || value.base === 'na',
    args.fn,
    name,
    'chart.point',
  );
  const ev = value.ev;
  return (rt) => (ev(rt) as PineObject | null) ?? null;
}

/** A point's x by xloc: its index, or its time. */
const pointX = (p: PineObject | null, xloc: string): number =>
  p ? (Number(p.fields[xloc === 'bar_time' ? 0 : 1]) as number) : Number.NaN;
const pointY = (p: PineObject | null): number => (p ? (p.fields[2] as number) : Number.NaN);

const num = (args: Args, name: string, fallback: number): Ev<number> => {
  const ev = args.number(name);
  return ev ? (rt) => ev(rt) : () => fallback;
};
const int = (args: Args, name: string, fallback: number): Ev<number> => {
  const ev = args.int(name);
  return ev ? (rt) => ev(rt) : () => fallback;
};
const text = (args: Args, name: string, fallback: string): Ev<string> => {
  const value = args.string(name);
  if (!value) return () => fallback;
  const ev = value.ev;
  return (rt) => {
    const v = ev(rt);
    return v === null || v === undefined ? '' : String(v);
  };
};
/** A size: size.* text, or (v6's text sizes) a number of points. */
const sizeArg = (args: Args, name: string, fallback: Value): Ev<Value> => {
  const value = args.get(name);
  if (!value) return () => fallback;
  const ev = value.ev;
  return (rt) => ev(rt) ?? fallback;
};
const color = (args: Args, name: string, fallback: number): Ev<number> => {
  const value = args.color(name);
  if (!value) return () => fallback;
  const ev = value.ev;
  return (rt) => ev(rt) as number;
};
const flag = (args: Args, name: string, fallback: boolean): Ev<boolean> => {
  const ev = args.bool(name);
  return ev ? (rt) => ev(rt) === true : () => fallback;
};

/** An x by bar index must be within 500 bars of the current one (Pine docs, Limitations). */
function checkX(rt: Runtime, x: number, xloc: string, span: Span): void {
  if (xloc !== 'bar_index' || Number.isNaN(x)) return;
  if (x > rt.index + MAX_BARS_FORWARD) {
    fail(
      `Objects positioned using xloc.bar_index cannot be drawn further than ${MAX_BARS_FORWARD} bars into the future`,
      span,
    );
  }
}

/** A handler that counts as an output: a script that only draws is a whole indicator. */
const drawing =
  (make: Handler): Handler =>
  (c, call, scope) => {
    c.usesObjects();
    c.otherOutputs++;
    return make(c, call, scope);
  };

/** A void call that changes a drawing (a setter, delete, clear). */
const act = (span: Span, run: (rt: Runtime) => void): Compiled =>
  series(
    'void',
    (rt) => {
      run(rt);
      return null;
    },
    span,
  );

/** The first argument compiled once, to tell an overload by its type (a chart.point or not). */
function firstIsPoint(
  c: Compiler,
  call: Call,
  scope: Scope,
  pointName: string,
): { call: Call; point: boolean } {
  const first = call.args[0];
  if (!first) return { call, point: false };
  if (first.name === pointName) return { call, point: true };
  if (first.name !== null) return { call, point: false };
  const compiled = c.expr(first.value, scope);
  return {
    call: {
      ...call,
      args: [
        { ...first, value: { kind: 'compiled', compiled, span: first.span } },
        ...call.args.slice(1),
      ],
    },
    point: compiled.base === 'chart.point',
  };
}

const LABEL_REST = [
  'text',
  'xloc',
  'yloc',
  'color',
  'style',
  'textcolor',
  'size',
  'textalign',
  'tooltip',
  'text_font_family',
  'force_overlay',
  'text_formatting',
];

function labelNew(c: Compiler, given: Call, scope: Scope): Compiled {
  const { call, point } = firstIsPoint(c, given, scope, 'point');
  const args = new Args(
    c,
    call,
    scope,
    point ? ['point', ...LABEL_REST] : ['x', 'y', ...LABEL_REST],
    point ? 1 : 2,
  );
  const pt = point ? pointArg(c, args, 'point') : null;
  const xEv = point ? null : int(args, 'x', Number.NaN);
  const yEv = point ? null : num(args, 'y', Number.NaN);
  const textEv = text(args, 'text', '');
  const xlocEv = text(args, 'xloc', 'bar_index');
  const ylocEv = text(args, 'yloc', 'price');
  const colorEv = color(args, 'color', COLORS.blue as number);
  const styleEv = text(args, 'style', 'label_down');
  const textcolorEv = color(args, 'textcolor', COLORS.black as number);
  const sizeEv = sizeArg(args, 'size', 'normal');
  const alignEv = text(args, 'textalign', 'center');
  const tooltipEv = text(args, 'tooltip', '');
  const fontEv = text(args, 'text_font_family', 'default');
  const formatEv = int(args, 'text_formatting', 0);
  const span = call.span;
  return series(
    'label',
    (rt) => {
      const l = new LabelObject();
      l.xloc = xlocEv(rt);
      if (pt) {
        const p = pt(rt);
        l.x = pointX(p, l.xloc);
        l.y = pointY(p);
      } else {
        l.x = (xEv as Ev<number>)(rt);
        l.y = (yEv as Ev<number>)(rt);
      }
      checkX(rt, l.x, l.xloc, span);
      l.text = textEv(rt);
      l.yloc = ylocEv(rt);
      l.color = colorEv(rt);
      l.style = styleEv(rt);
      l.textcolor = textcolorEv(rt);
      l.size = sizeEv(rt);
      l.textalign = alignEv(rt);
      l.tooltip = tooltipEv(rt);
      l.font = fontEv(rt);
      l.formatting = formatEv(rt) || 0;
      rt.drawings.add(rt, l);
      return l as unknown as Value;
    },
    span,
  );
}

const LINE_REST = ['xloc', 'extend', 'color', 'style', 'width', 'force_overlay'];

function lineNew(c: Compiler, given: Call, scope: Scope): Compiled {
  const { call, point } = firstIsPoint(c, given, scope, 'first_point');
  const args = new Args(
    c,
    call,
    scope,
    point ? ['first_point', 'second_point', ...LINE_REST] : ['x1', 'y1', 'x2', 'y2', ...LINE_REST],
    point ? 2 : 4,
  );
  const p1 = point ? pointArg(c, args, 'first_point') : null;
  const p2 = point ? pointArg(c, args, 'second_point') : null;
  const x1 = point ? null : int(args, 'x1', Number.NaN);
  const y1 = point ? null : num(args, 'y1', Number.NaN);
  const x2 = point ? null : int(args, 'x2', Number.NaN);
  const y2 = point ? null : num(args, 'y2', Number.NaN);
  const xlocEv = text(args, 'xloc', 'bar_index');
  const extendEv = text(args, 'extend', 'none');
  const colorEv = color(args, 'color', COLORS.blue as number);
  const styleEv = text(args, 'style', 'solid');
  const widthEv = int(args, 'width', 1);
  const span = call.span;
  return series(
    'line',
    (rt) => {
      const l = new LineObject();
      l.xloc = xlocEv(rt);
      if (p1 && p2) {
        const a = p1(rt);
        const b = p2(rt);
        l.x1 = pointX(a, l.xloc);
        l.y1 = pointY(a);
        l.x2 = pointX(b, l.xloc);
        l.y2 = pointY(b);
      } else {
        l.x1 = (x1 as Ev<number>)(rt);
        l.y1 = (y1 as Ev<number>)(rt);
        l.x2 = (x2 as Ev<number>)(rt);
        l.y2 = (y2 as Ev<number>)(rt);
      }
      checkX(rt, Math.max(l.x1, l.x2), l.xloc, span);
      l.extend = extendEv(rt);
      l.color = colorEv(rt);
      l.style = styleEv(rt);
      l.width = Math.max(1, widthEv(rt) || 1);
      rt.drawings.add(rt, l);
      return l as unknown as Value;
    },
    span,
  );
}

const BOX_REST = [
  'border_color',
  'border_width',
  'border_style',
  'extend',
  'xloc',
  'bgcolor',
  'text',
  'text_size',
  'text_color',
  'text_halign',
  'text_valign',
  'text_wrap',
  'text_font_family',
  'force_overlay',
  'text_formatting',
];

function boxNew(c: Compiler, given: Call, scope: Scope): Compiled {
  const { call, point } = firstIsPoint(c, given, scope, 'top_left');
  const args = new Args(
    c,
    call,
    scope,
    point
      ? ['top_left', 'bottom_right', ...BOX_REST]
      : ['left', 'top', 'right', 'bottom', ...BOX_REST],
    point ? 2 : 4,
  );
  const tl = point ? pointArg(c, args, 'top_left') : null;
  const br = point ? pointArg(c, args, 'bottom_right') : null;
  const left = point ? null : int(args, 'left', Number.NaN);
  const top = point ? null : num(args, 'top', Number.NaN);
  const right = point ? null : int(args, 'right', Number.NaN);
  const bottom = point ? null : num(args, 'bottom', Number.NaN);
  const borderColorEv = color(args, 'border_color', COLORS.blue as number);
  const borderWidthEv = int(args, 'border_width', 1);
  const borderStyleEv = text(args, 'border_style', 'solid');
  const extendEv = text(args, 'extend', 'none');
  const xlocEv = text(args, 'xloc', 'bar_index');
  const bgEv = color(args, 'bgcolor', COLORS.blue as number);
  const textEv = text(args, 'text', '');
  const sizeEv = sizeArg(args, 'text_size', 'auto');
  const textColorEv = color(args, 'text_color', COLORS.black as number);
  const halignEv = text(args, 'text_halign', 'center');
  const valignEv = text(args, 'text_valign', 'center');
  const wrapEv = text(args, 'text_wrap', 'none');
  const fontEv = text(args, 'text_font_family', 'default');
  const formatEv = int(args, 'text_formatting', 0);
  const span = call.span;
  return series(
    'box',
    (rt) => {
      const b = new BoxObject();
      b.xloc = xlocEv(rt);
      if (tl && br) {
        const p = tl(rt);
        const q = br(rt);
        b.left = pointX(p, b.xloc);
        b.top = pointY(p);
        b.right = pointX(q, b.xloc);
        b.bottom = pointY(q);
      } else {
        b.left = (left as Ev<number>)(rt);
        b.top = (top as Ev<number>)(rt);
        b.right = (right as Ev<number>)(rt);
        b.bottom = (bottom as Ev<number>)(rt);
      }
      checkX(rt, Math.max(b.left, b.right), b.xloc, span);
      b.borderColor = borderColorEv(rt);
      b.borderWidth = borderWidthEv(rt);
      b.borderStyle = borderStyleEv(rt);
      b.extend = extendEv(rt);
      b.bgcolor = bgEv(rt);
      b.text = textEv(rt);
      b.textSize = sizeEv(rt);
      b.textColor = textColorEv(rt);
      b.textHalign = halignEv(rt);
      b.textValign = valignEv(rt);
      b.textWrap = wrapEv(rt);
      b.font = fontEv(rt);
      b.formatting = formatEv(rt) || 0;
      rt.drawings.add(rt, b);
      return b as unknown as Value;
    },
    span,
  );
}

function tableNew(c: Compiler, call: Call, scope: Scope): Compiled {
  const args = new Args(
    c,
    call,
    scope,
    [
      'position',
      'columns',
      'rows',
      'bgcolor',
      'frame_color',
      'frame_width',
      'border_color',
      'border_width',
      'force_overlay',
    ],
    3,
  );
  const positionEv = text(args, 'position', 'top_right');
  const columnsEv = int(args, 'columns', 1);
  const rowsEv = int(args, 'rows', 1);
  const bgEv = color(args, 'bgcolor', Number.NaN);
  const frameColorEv = color(args, 'frame_color', Number.NaN);
  const frameWidthEv = int(args, 'frame_width', 0);
  const borderColorEv = color(args, 'border_color', Number.NaN);
  const borderWidthEv = int(args, 'border_width', 0);
  return series(
    'table',
    (rt) => {
      const t = new TableObject();
      t.position = positionEv(rt);
      t.columns = Math.max(0, columnsEv(rt) || 0);
      t.rows = Math.max(0, rowsEv(rt) || 0);
      t.cells = Array.from({ length: t.rows }, () => Array.from({ length: t.columns }, () => null));
      t.bgcolor = bgEv(rt);
      t.frameColor = frameColorEv(rt);
      t.frameWidth = frameWidthEv(rt) || 0;
      t.borderColor = borderColorEv(rt);
      t.borderWidth = borderWidthEv(rt) || 0;
      rt.drawings.add(rt, t);
      return t as unknown as Value;
    },
    call.span,
  );
}

const CELL_PARAMS = [
  'text',
  'width',
  'height',
  'text_color',
  'text_halign',
  'text_valign',
  'text_size',
  'bgcolor',
  'tooltip',
  'text_font_family',
  'text_formatting',
];

/** The cell at a column and row, or an error past the table's edge (TradingView's own message). */
function cellAt(t: TableObject, column: number, row: number, span: Span): number[] {
  if (!(column >= 0 && column < t.columns && row >= 0 && row < t.rows)) {
    fail(
      `Cell with the column index ${column} and the row index ${row} is outside the table. The table has ${t.columns} columns and ${t.rows} rows`,
      span,
    );
  }
  return [Math.floor(column), Math.floor(row)];
}

/** Replaces a table's cells array (so the live bar's next update can put the old one back). */
function changeCells(
  rt: Runtime,
  t: TableObject,
  change: (cells: (TableCell | null)[][]) => void,
): void {
  if (t.deleted) return;
  const next = t.cells.map((row) => row.slice());
  change(next);
  rt.drawings.set(rt, t, 'cells', next);
}

function tableCell(c: Compiler, call: Call, scope: Scope): Compiled {
  const args = new Args(c, call, scope, ['table_id', 'column', 'row', ...CELL_PARAMS], 3);
  const id = idArg<TableObject>(c, args, 'table_id', 'table');
  const columnEv = int(args, 'column', 0);
  const rowEv = int(args, 'row', 0);
  const textEv = text(args, 'text', '');
  const widthEv = num(args, 'width', 0);
  const heightEv = num(args, 'height', 0);
  const textColorEv = color(args, 'text_color', COLORS.black as number);
  const halignEv = text(args, 'text_halign', 'center');
  const valignEv = text(args, 'text_valign', 'center');
  const sizeEv = sizeArg(args, 'text_size', 'normal');
  const bgEv = color(args, 'bgcolor', Number.NaN);
  const tooltipEv = text(args, 'tooltip', '');
  const fontEv = text(args, 'text_font_family', 'default');
  const formatEv = int(args, 'text_formatting', 0);
  const span = call.span;
  return act(span, (rt) => {
    const t = id(rt);
    if (!t) return;
    const [col, row] = cellAt(t, columnEv(rt), rowEv(rt), span) as [number, number];
    const cell: TableCell = {
      text: textEv(rt),
      width: widthEv(rt) || 0,
      height: heightEv(rt) || 0,
      textColor: textColorEv(rt),
      textHalign: halignEv(rt),
      textValign: valignEv(rt),
      textSize: sizeEv(rt),
      bgcolor: bgEv(rt),
      tooltip: tooltipEv(rt),
      font: fontEv(rt),
      formatting: formatEv(rt) || 0,
    };
    changeCells(rt, t, (cells) => {
      (cells[row] as (TableCell | null)[])[col] = cell;
    });
  });
}

/** table.cell_set_*(): one property of a cell, made if it wasn't. */
function cellSetter(key: keyof TableCell, kind: 'text' | 'number' | 'color' | 'size'): Handler {
  return (c, call, scope) => {
    const param =
      key === 'textColor'
        ? 'text_color'
        : key === 'textHalign'
          ? 'text_halign'
          : key === 'textValign'
            ? 'text_valign'
            : key === 'textSize'
              ? 'text_size'
              : key === 'font'
                ? 'text_font_family'
                : key === 'formatting'
                  ? 'text_formatting'
                  : key;
    const args = new Args(c, call, scope, ['table_id', 'column', 'row', param], 4);
    const id = idArg<TableObject>(c, args, 'table_id', 'table');
    const columnEv = int(args, 'column', 0);
    const rowEv = int(args, 'row', 0);
    const value: Ev<Value> =
      kind === 'text'
        ? text(args, param, '')
        : kind === 'color'
          ? color(args, param, Number.NaN)
          : kind === 'size'
            ? sizeArg(args, param, 'normal')
            : num(args, param, 0);
    const span = call.span;
    return act(span, (rt) => {
      const t = id(rt);
      if (!t) return;
      const [col, row] = cellAt(t, columnEv(rt), rowEv(rt), span) as [number, number];
      const v = value(rt);
      changeCells(rt, t, (cells) => {
        const line = cells[row] as (TableCell | null)[];
        const cell: TableCell = line[col]
          ? { ...(line[col] as TableCell) }
          : {
              text: '',
              width: 0,
              height: 0,
              textColor: COLORS.black as number,
              textHalign: 'center',
              textValign: 'center',
              textSize: 'normal',
              bgcolor: Number.NaN,
              tooltip: '',
              font: 'default',
              formatting: 0,
            };
        (cell as unknown as Record<string, Value>)[key] = v;
        line[col] = cell;
      });
    });
  };
}

/** A setter of one property: `<kind>.set_<name>(id, value)`. */
function setter<T extends AnyDrawing>(
  kind: DrawingKind,
  param: string,
  read: (args: Args) => Ev<Value>,
  apply: (rt: Runtime, item: T, value: Value) => void,
): Handler {
  return (c, call, scope) => {
    const args = new Args(c, call, scope, ['id', param], 2);
    const id = idArg<T>(c, args, 'id', kind);
    const value = read(args);
    return act(call.span, (rt) => {
      const item = id(rt);
      if (item) apply(rt, item, value(rt));
    });
  };
}

/** A setter of two properties: set_xy(id, x, y) and the like. */
function setter2<T extends AnyDrawing>(
  kind: DrawingKind,
  params: [string, string],
  reads: [(args: Args) => Ev<Value>, (args: Args) => Ev<Value>],
  apply: (rt: Runtime, item: T, a: Value, b: Value) => void,
): Handler {
  return (c, call, scope) => {
    const args = new Args(c, call, scope, ['id', ...params], 3);
    const id = idArg<T>(c, args, 'id', kind);
    const a = reads[0](args);
    const b = reads[1](args);
    return act(call.span, (rt) => {
      const item = id(rt);
      if (item) apply(rt, item, a(rt), b(rt));
    });
  };
}

/** A getter: `<kind>.get_<name>(id)`, na for na. */
function getter<T extends AnyDrawing>(
  kind: DrawingKind,
  base: string,
  read: (item: T) => Value,
): Handler {
  return (c, call, scope) => {
    const args = new Args(c, call, scope, ['id'], 1);
    const id = idArg<T>(c, args, 'id', kind);
    const na: Value = base === 'string' ? '' : Number.NaN;
    return series(
      base,
      (rt) => {
        const item = id(rt);
        return item ? read(item) : na;
      },
      call.span,
    );
  };
}

const deleter =
  (kind: DrawingKind): Handler =>
  (c, call, scope) => {
    const args = new Args(c, call, scope, ['id'], 1);
    const id = idArg(c, args, 'id', kind);
    return act(call.span, (rt) => {
      const item = id(rt);
      if (item) rt.drawings.remove(rt, item);
    });
  };

const copier =
  (kind: DrawingKind): Handler =>
  (c, call, scope) => {
    c.usesObjects();
    const args = new Args(c, call, scope, ['id'], 1);
    const id = idArg(c, args, 'id', kind);
    return series(
      kind,
      (rt) => {
        const item = id(rt);
        if (!item) return null;
        const copy = Object.assign(Object.create(Object.getPrototypeOf(item)), item, {
          id: nextId++,
          deleted: false,
        }) as AnyDrawing;
        if (copy.kind === 'table') {
          copy.cells = (item as TableObject).cells.map((row) =>
            row.map((cell) => (cell ? { ...cell } : null)),
          );
          copy.merges = (item as TableObject).merges.map((m) => ({ ...m }));
        }
        if (copy.kind === 'polyline')
          copy.points = (item as PolylineObject).points.map((p) => ({ ...p }));
        rt.drawings.add(rt, copy);
        return copy as unknown as Value;
      },
      call.span,
    );
  };

const readNum = (name: string) => (args: Args) => num(args, name, Number.NaN);
const readInt = (name: string) => (args: Args) => int(args, name, Number.NaN);
const readText = (name: string) => (args: Args) => text(args, name, '');
const readColor = (name: string) => (args: Args) => color(args, name, Number.NaN);
const readSize = (name: string) => (args: Args) => sizeArg(args, name, 'normal');

/** A setter that writes one field of the object as is. */
const field =
  <T extends AnyDrawing>(key: keyof T) =>
  (rt: Runtime, item: T, value: Value) =>
    rt.drawings.set(rt, item, key, value as T[keyof T]);

/** Where a line is at an x by bar index: the price along it (the v6 reference, line.get_price). */
export function linePrice(l: LineObject, x: number): number {
  if (l.x1 === l.x2) return l.y1;
  return l.y1 + ((l.y2 - l.y1) * (x - l.x1)) / (l.x2 - l.x1);
}

function pointCalls(): Record<string, Handler> {
  const make = (time: Value, index: Value, price: Value) =>
    new PineObject('chart.point', [time, index, price]) as unknown as Value;
  return {
    'chart.point.new': (c, call, scope) => {
      const args = new Args(c, call, scope, ['time', 'index', 'price'], 3);
      const t = int(args, 'time', Number.NaN);
      const i = int(args, 'index', Number.NaN);
      const p = num(args, 'price', Number.NaN);
      return series('chart.point', (rt) => make(t(rt), i(rt), p(rt)), call.span);
    },
    'chart.point.from_index': (c, call, scope) => {
      const args = new Args(c, call, scope, ['index', 'price'], 2);
      const i = int(args, 'index', Number.NaN);
      const p = num(args, 'price', Number.NaN);
      return series('chart.point', (rt) => make(Number.NaN, i(rt), p(rt)), call.span);
    },
    'chart.point.from_time': (c, call, scope) => {
      const args = new Args(c, call, scope, ['time', 'price'], 2);
      const t = int(args, 'time', Number.NaN);
      const p = num(args, 'price', Number.NaN);
      return series('chart.point', (rt) => make(t(rt), Number.NaN, p(rt)), call.span);
    },
    'chart.point.now': (c, call, scope) => {
      // The current bar's time and index; its close when no price is given (the v6 reference).
      const args = new Args(c, call, scope, ['price'], 0);
      const p = args.number('price');
      return series(
        'chart.point',
        (rt) => {
          const bar = rt.bar;
          const time = bar ? (bar.start ?? bar.time * 1000) : Number.NaN;
          return make(time, rt.index, p ? p(rt) : (bar?.close ?? Number.NaN));
        },
        call.span,
      );
    },
    'chart.point.copy': (c, call, scope) => {
      const args = new Args(c, call, scope, ['id'], 1);
      const id = pointArg(c, args, 'id') as Ev<PineObject | null>;
      return series(
        'chart.point',
        (rt) => {
          const p = id(rt);
          return p
            ? make(p.fields[0] ?? Number.NaN, p.fields[1] ?? Number.NaN, p.fields[2] ?? Number.NaN)
            : null;
        },
        call.span,
      );
    },
  };
}

function labelCalls(): Record<string, Handler> {
  type L = LabelObject;
  return {
    'label.new': drawing(labelNew),
    'label.delete': deleter('label'),
    'label.copy': copier('label'),
    'label.get_x': getter<L>('label', 'int', (l) => l.x),
    'label.get_y': getter<L>('label', 'float', (l) => l.y),
    'label.get_text': getter<L>('label', 'string', (l) => l.text),
    'label.set_x': setter<L>('label', 'x', readInt('x'), field<L>('x')),
    'label.set_y': setter<L>('label', 'y', readNum('y'), field<L>('y')),
    'label.set_xy': setter2<L>('label', ['x', 'y'], [readInt('x'), readNum('y')], (rt, l, x, y) => {
      rt.drawings.set(rt, l, 'x', x as number);
      rt.drawings.set(rt, l, 'y', y as number);
    }),
    'label.set_point': (c, call, scope) => {
      const args = new Args(c, call, scope, ['id', 'point'], 2);
      const id = idArg<L>(c, args, 'id', 'label');
      const pt = pointArg(c, args, 'point') as Ev<PineObject | null>;
      return act(call.span, (rt) => {
        const l = id(rt);
        if (!l) return;
        const p = pt(rt);
        rt.drawings.set(rt, l, 'x', pointX(p, l.xloc));
        rt.drawings.set(rt, l, 'y', pointY(p));
      });
    },
    'label.set_xloc': setter2<L>(
      'label',
      ['x', 'xloc'],
      [readInt('x'), readText('xloc')],
      (rt, l, x, xloc) => {
        rt.drawings.set(rt, l, 'xloc', String(xloc));
        rt.drawings.set(rt, l, 'x', x as number);
      },
    ),
    'label.set_yloc': setter<L>('label', 'yloc', readText('yloc'), field<L>('yloc')),
    'label.set_text': setter<L>('label', 'text', readText('text'), field<L>('text')),
    'label.set_tooltip': setter<L>('label', 'tooltip', readText('tooltip'), field<L>('tooltip')),
    'label.set_color': setter<L>('label', 'color', readColor('color'), field<L>('color')),
    'label.set_textcolor': setter<L>(
      'label',
      'textcolor',
      readColor('textcolor'),
      field<L>('textcolor'),
    ),
    'label.set_style': setter<L>('label', 'style', readText('style'), field<L>('style')),
    'label.set_size': setter<L>('label', 'size', readSize('size'), field<L>('size')),
    'label.set_textalign': setter<L>(
      'label',
      'textalign',
      readText('textalign'),
      field<L>('textalign'),
    ),
    'label.set_text_font_family': setter<L>(
      'label',
      'text_font_family',
      readText('text_font_family'),
      field<L>('font'),
    ),
    'label.set_text_formatting': setter<L>(
      'label',
      'text_formatting',
      readInt('text_formatting'),
      field<L>('formatting'),
    ),
  };
}

function lineCalls(): Record<string, Handler> {
  type L = LineObject;
  return {
    'line.new': drawing(lineNew),
    'line.delete': deleter('line'),
    'line.copy': copier('line'),
    'line.get_x1': getter<L>('line', 'int', (l) => l.x1),
    'line.get_y1': getter<L>('line', 'float', (l) => l.y1),
    'line.get_x2': getter<L>('line', 'int', (l) => l.x2),
    'line.get_y2': getter<L>('line', 'float', (l) => l.y2),
    'line.get_price': (c, call, scope) => {
      const args = new Args(c, call, scope, ['id', 'x'], 2);
      const id = idArg<L>(c, args, 'id', 'line');
      const x = int(args, 'x', Number.NaN);
      const span = call.span;
      return series(
        'float',
        (rt) => {
          const l = id(rt);
          if (!l) return Number.NaN;
          // "The line must be drawn using xloc.bar_index" (the v6 reference).
          if (l.xloc !== 'bar_index')
            fail('line.get_price() works only on lines drawn with xloc.bar_index', span);
          return linePrice(l, x(rt));
        },
        span,
      );
    },
    'line.set_x1': setter<L>('line', 'x', readInt('x'), field<L>('x1')),
    'line.set_y1': setter<L>('line', 'y', readNum('y'), field<L>('y1')),
    'line.set_x2': setter<L>('line', 'x', readInt('x'), field<L>('x2')),
    'line.set_y2': setter<L>('line', 'y', readNum('y'), field<L>('y2')),
    'line.set_xy1': setter2<L>('line', ['x', 'y'], [readInt('x'), readNum('y')], (rt, l, x, y) => {
      rt.drawings.set(rt, l, 'x1', x as number);
      rt.drawings.set(rt, l, 'y1', y as number);
    }),
    'line.set_xy2': setter2<L>('line', ['x', 'y'], [readInt('x'), readNum('y')], (rt, l, x, y) => {
      rt.drawings.set(rt, l, 'x2', x as number);
      rt.drawings.set(rt, l, 'y2', y as number);
    }),
    'line.set_first_point': pointSetter<L>('line', (rt, l, p) => {
      rt.drawings.set(rt, l, 'x1', pointX(p, l.xloc));
      rt.drawings.set(rt, l, 'y1', pointY(p));
    }),
    'line.set_second_point': pointSetter<L>('line', (rt, l, p) => {
      rt.drawings.set(rt, l, 'x2', pointX(p, l.xloc));
      rt.drawings.set(rt, l, 'y2', pointY(p));
    }),
    'line.set_xloc': (c, call, scope) => {
      const args = new Args(c, call, scope, ['id', 'x1', 'x2', 'xloc'], 4);
      const id = idArg<L>(c, args, 'id', 'line');
      const x1 = int(args, 'x1', Number.NaN);
      const x2 = int(args, 'x2', Number.NaN);
      const xloc = text(args, 'xloc', 'bar_index');
      return act(call.span, (rt) => {
        const l = id(rt);
        if (!l) return;
        rt.drawings.set(rt, l, 'xloc', xloc(rt));
        rt.drawings.set(rt, l, 'x1', x1(rt));
        rt.drawings.set(rt, l, 'x2', x2(rt));
      });
    },
    'line.set_extend': setter<L>('line', 'extend', readText('extend'), field<L>('extend')),
    'line.set_color': setter<L>('line', 'color', readColor('color'), field<L>('color')),
    'line.set_style': setter<L>('line', 'style', readText('style'), field<L>('style')),
    'line.set_width': setter<L>('line', 'width', readInt('width'), (rt, l, w) =>
      rt.drawings.set(rt, l, 'width', Math.max(1, (w as number) || 1)),
    ),
  };
}

/** A setter taking a chart.point: set_first_point(id, point) and the like. */
function pointSetter<T extends AnyDrawing>(
  kind: DrawingKind,
  apply: (rt: Runtime, item: T, p: PineObject | null) => void,
): Handler {
  return (c, call, scope) => {
    const args = new Args(c, call, scope, ['id', 'point'], 2);
    const id = idArg<T>(c, args, 'id', kind);
    const pt = pointArg(c, args, 'point') as Ev<PineObject | null>;
    return act(call.span, (rt) => {
      const item = id(rt);
      if (item) apply(rt, item, pt(rt));
    });
  };
}

function boxCalls(): Record<string, Handler> {
  type B = BoxObject;
  return {
    'box.new': drawing(boxNew),
    'box.delete': deleter('box'),
    'box.copy': copier('box'),
    'box.get_left': getter<B>('box', 'int', (b) => b.left),
    'box.get_top': getter<B>('box', 'float', (b) => b.top),
    'box.get_right': getter<B>('box', 'int', (b) => b.right),
    'box.get_bottom': getter<B>('box', 'float', (b) => b.bottom),
    'box.set_left': setter<B>('box', 'left', readInt('left'), field<B>('left')),
    'box.set_top': setter<B>('box', 'top', readNum('top'), field<B>('top')),
    'box.set_right': setter<B>('box', 'right', readInt('right'), field<B>('right')),
    'box.set_bottom': setter<B>('box', 'bottom', readNum('bottom'), field<B>('bottom')),
    'box.set_lefttop': setter2<B>(
      'box',
      ['left', 'top'],
      [readInt('left'), readNum('top')],
      (rt, b, x, y) => {
        rt.drawings.set(rt, b, 'left', x as number);
        rt.drawings.set(rt, b, 'top', y as number);
      },
    ),
    'box.set_rightbottom': setter2<B>(
      'box',
      ['right', 'bottom'],
      [readInt('right'), readNum('bottom')],
      (rt, b, x, y) => {
        rt.drawings.set(rt, b, 'right', x as number);
        rt.drawings.set(rt, b, 'bottom', y as number);
      },
    ),
    'box.set_top_left_point': pointSetter<B>('box', (rt, b, p) => {
      rt.drawings.set(rt, b, 'left', pointX(p, b.xloc));
      rt.drawings.set(rt, b, 'top', pointY(p));
    }),
    'box.set_bottom_right_point': pointSetter<B>('box', (rt, b, p) => {
      rt.drawings.set(rt, b, 'right', pointX(p, b.xloc));
      rt.drawings.set(rt, b, 'bottom', pointY(p));
    }),
    'box.set_xloc': (c, call, scope) => {
      const args = new Args(c, call, scope, ['id', 'left', 'right', 'xloc'], 4);
      const id = idArg<B>(c, args, 'id', 'box');
      const left = int(args, 'left', Number.NaN);
      const right = int(args, 'right', Number.NaN);
      const xloc = text(args, 'xloc', 'bar_index');
      return act(call.span, (rt) => {
        const b = id(rt);
        if (!b) return;
        rt.drawings.set(rt, b, 'xloc', xloc(rt));
        rt.drawings.set(rt, b, 'left', left(rt));
        rt.drawings.set(rt, b, 'right', right(rt));
      });
    },
    'box.set_extend': setter<B>('box', 'extend', readText('extend'), field<B>('extend')),
    'box.set_border_color': setter<B>('box', 'color', readColor('color'), field<B>('borderColor')),
    'box.set_border_width': setter<B>('box', 'width', readInt('width'), field<B>('borderWidth')),
    'box.set_border_style': setter<B>('box', 'style', readText('style'), field<B>('borderStyle')),
    'box.set_bgcolor': setter<B>('box', 'color', readColor('color'), field<B>('bgcolor')),
    'box.set_text': setter<B>('box', 'text', readText('text'), field<B>('text')),
    'box.set_text_size': setter<B>('box', 'text_size', readSize('text_size'), field<B>('textSize')),
    'box.set_text_color': setter<B>(
      'box',
      'text_color',
      readColor('text_color'),
      field<B>('textColor'),
    ),
    'box.set_text_halign': setter<B>(
      'box',
      'text_halign',
      readText('text_halign'),
      field<B>('textHalign'),
    ),
    'box.set_text_valign': setter<B>(
      'box',
      'text_valign',
      readText('text_valign'),
      field<B>('textValign'),
    ),
    'box.set_text_wrap': setter<B>('box', 'text_wrap', readText('text_wrap'), field<B>('textWrap')),
    'box.set_text_font_family': setter<B>(
      'box',
      'text_font_family',
      readText('text_font_family'),
      field<B>('font'),
    ),
    'box.set_text_formatting': setter<B>(
      'box',
      'text_formatting',
      readInt('text_formatting'),
      field<B>('formatting'),
    ),
  };
}

function tableCalls(): Record<string, Handler> {
  type T = TableObject;
  const tableSetter =
    (param: string, read: (args: Args) => Ev<Value>, key: keyof T): Handler =>
    (c, call, scope) => {
      const args = new Args(c, call, scope, ['table_id', param], 2);
      const id = idArg<T>(c, args, 'table_id', 'table');
      const value = read(args);
      return act(call.span, (rt) => {
        const t = id(rt);
        if (t) rt.drawings.set(rt, t, key, value(rt) as T[keyof T]);
      });
    };
  return {
    'table.new': drawing(tableNew),
    'table.cell': tableCell,
    'table.delete': (c, call, scope) => {
      const args = new Args(c, call, scope, ['table_id'], 1);
      const id = idArg<T>(c, args, 'table_id', 'table');
      return act(call.span, (rt) => {
        const t = id(rt);
        if (t) rt.drawings.remove(rt, t);
      });
    },
    'table.clear': (c, call, scope) => {
      const args = new Args(
        c,
        call,
        scope,
        ['table_id', 'start_column', 'start_row', 'end_column', 'end_row'],
        3,
      );
      const id = idArg<T>(c, args, 'table_id', 'table');
      const c0 = int(args, 'start_column', 0);
      const r0 = int(args, 'start_row', 0);
      const c1 = args.int('end_column');
      const r1 = args.int('end_row');
      return act(call.span, (rt) => {
        const t = id(rt);
        if (!t) return;
        const a = c0(rt);
        const b = r0(rt);
        const e = c1 ? c1(rt) : a;
        const f = r1 ? r1(rt) : b;
        changeCells(rt, t, (cells) => {
          for (let r = b; r <= f; r++)
            for (let col = a; col <= e; col++)
              if (cells[r]) (cells[r] as (TableCell | null)[])[col] = null;
        });
        rt.drawings.set(
          rt,
          t,
          'merges',
          t.merges.filter((m) => m.c1 < a || m.c0 > e || m.r1 < b || m.r0 > f),
        );
      });
    },
    'table.merge_cells': (c, call, scope) => {
      const args = new Args(
        c,
        call,
        scope,
        ['table_id', 'start_column', 'start_row', 'end_column', 'end_row'],
        5,
      );
      const id = idArg<T>(c, args, 'table_id', 'table');
      const c0 = int(args, 'start_column', 0);
      const r0 = int(args, 'start_row', 0);
      const c1 = int(args, 'end_column', 0);
      const r1 = int(args, 'end_row', 0);
      return act(call.span, (rt) => {
        const t = id(rt);
        if (!t) return;
        rt.drawings.set(rt, t, 'merges', [
          ...t.merges,
          { c0: c0(rt), r0: r0(rt), c1: c1(rt), r1: r1(rt) },
        ]);
      });
    },
    'table.set_position': tableSetter('position', readText('position'), 'position'),
    'table.set_bgcolor': tableSetter('bgcolor', readColor('bgcolor'), 'bgcolor'),
    'table.set_frame_color': tableSetter('frame_color', readColor('frame_color'), 'frameColor'),
    'table.set_frame_width': tableSetter('frame_width', readInt('frame_width'), 'frameWidth'),
    'table.set_border_color': tableSetter('border_color', readColor('border_color'), 'borderColor'),
    'table.set_border_width': tableSetter('border_width', readInt('border_width'), 'borderWidth'),
    'table.cell_set_text': cellSetter('text', 'text'),
    'table.cell_set_tooltip': cellSetter('tooltip', 'text'),
    'table.cell_set_width': cellSetter('width', 'number'),
    'table.cell_set_height': cellSetter('height', 'number'),
    'table.cell_set_text_color': cellSetter('textColor', 'color'),
    'table.cell_set_bgcolor': cellSetter('bgcolor', 'color'),
    'table.cell_set_text_halign': cellSetter('textHalign', 'text'),
    'table.cell_set_text_valign': cellSetter('textValign', 'text'),
    'table.cell_set_text_size': cellSetter('textSize', 'size'),
    'table.cell_set_text_font_family': cellSetter('font', 'text'),
    'table.cell_set_text_formatting': cellSetter('formatting', 'number'),
  };
}

function polylineCalls(): Record<string, Handler> {
  return {
    'polyline.new': drawing((c, call, scope) => {
      const args = new Args(
        c,
        call,
        scope,
        [
          'points',
          'curved',
          'closed',
          'xloc',
          'line_color',
          'fill_color',
          'line_style',
          'line_width',
          'force_overlay',
        ],
        1,
      );
      const pointsArg = args.get('points') as Compiled;
      c.needType(
        pointsArg,
        pointsArg.base === 'array<chart.point>' || pointsArg.base === 'na',
        args.fn,
        'points',
        'array<chart.point>',
      );
      const pointsEv = pointsArg.ev;
      const curved = flag(args, 'curved', false);
      const closed = flag(args, 'closed', false);
      const xlocEv = text(args, 'xloc', 'bar_index');
      const lineColor = color(args, 'line_color', COLORS.blue as number);
      const fillColor = color(args, 'fill_color', Number.NaN);
      const lineStyle = text(args, 'line_style', 'solid');
      const lineWidth = int(args, 'line_width', 1);
      return series(
        'polyline',
        (rt) => {
          const array = pointsEv(rt) as PineArray | null;
          const p = new PolylineObject();
          p.xloc = xlocEv(rt);
          // The points are copied: changing the array later doesn't move the polyline.
          p.points = (array?.items ?? [])
            .filter((pt): pt is PineObject => pt instanceof PineObject)
            .map((pt) => ({ x: pointX(pt, p.xloc), y: pointY(pt) }));
          p.curved = curved(rt);
          p.closed = closed(rt);
          p.lineColor = lineColor(rt);
          p.fillColor = fillColor(rt);
          p.lineStyle = lineStyle(rt);
          p.lineWidth = Math.max(1, lineWidth(rt) || 1);
          rt.drawings.add(rt, p);
          return p as unknown as Value;
        },
        call.span,
      );
    }),
    'polyline.delete': deleter('polyline'),
  };
}

function linefillCalls(): Record<string, Handler> {
  type F = LinefillObject;
  return {
    'linefill.new': drawing((c, call, scope) => {
      const args = new Args(c, call, scope, ['line1', 'line2', 'color'], 3);
      const l1 = idArg<LineObject>(c, args, 'line1', 'line');
      const l2 = idArg<LineObject>(c, args, 'line2', 'line');
      const colorEv = color(args, 'color', Number.NaN);
      return series(
        'linefill',
        (rt) => {
          const a = l1(rt);
          const b = l2(rt);
          if (!a || !b) return null;
          // One linefill per pair of lines: a second call changes the first (the v6 reference).
          const existing = rt.drawings.linefills.find(
            (f) => (f.line1 === a && f.line2 === b) || (f.line1 === b && f.line2 === a),
          );
          if (existing) {
            rt.drawings.set(rt, existing, 'color', colorEv(rt));
            return existing as unknown as Value;
          }
          const fill = new LinefillObject(a, b, colorEv(rt));
          rt.drawings.add(rt, fill);
          return fill as unknown as Value;
        },
        call.span,
      );
    }),
    'linefill.delete': deleter('linefill'),
    'linefill.set_color': setter<F>('linefill', 'color', readColor('color'), field<F>('color')),
    'linefill.get_line1': (c, call, scope) => {
      const args = new Args(c, call, scope, ['id'], 1);
      const id = idArg<F>(c, args, 'id', 'linefill');
      return series('line', (rt) => (id(rt)?.line1 ?? null) as unknown as Value, call.span);
    },
    'linefill.get_line2': (c, call, scope) => {
      const args = new Args(c, call, scope, ['id'], 1);
      const id = idArg<F>(c, args, 'id', 'linefill');
      return series('line', (rt) => (id(rt)?.line2 ?? null) as unknown as Value, call.span);
    },
  };
}

/** Every drawing function, by its full name. */
export function drawingCalls(): Record<string, Handler> {
  return {
    ...pointCalls(),
    ...labelCalls(),
    ...lineCalls(),
    ...boxCalls(),
    ...tableCalls(),
    ...polylineCalls(),
    ...linefillCalls(),
  };
}

/** The type casts label(x), line(x) and the rest (the v6 reference: they take na). */
export function drawingCasts(): Record<string, Handler> {
  const cast =
    (kind: DrawingKind): Handler =>
    (c, call, scope) => {
      const args = new Args(c, call, scope, ['x'], 1);
      const value = args.get('x') as Compiled;
      c.needType(value, value.base === kind || value.base === 'na', kind, 'x', kind);
      const ev = value.ev;
      return series(kind, (rt) => ev(rt) ?? null, call.span);
    };
  return {
    label: cast('label'),
    line: cast('line'),
    box: cast('box'),
    table: cast('table'),
    linefill: cast('linefill'),
  };
}
