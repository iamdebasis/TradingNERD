import {
  copyStyle,
  type Drawing,
  type DrawingStyle,
  type DrawingTool,
  isDrawingTool,
  parseDrawingStyle,
} from './drawings.ts';

/**
 * Drawing templates (docs/SPEC.md §5.27, D3b): a style saved under a name for one tool, as
 * TradingView's are (Help Center, How to apply a template to several tools of the same type at
 * once?; blog, Templates for same-type drawings; its Charting Library keeps them per tool, by
 * name: drawing template methods). The gateway keeps them in `data/drawing-templates.json`.
 *
 * A template holds a drawing's style without its text: never its points, visibility, lock or
 * place (ours: TradingView says only "a set of properties"; provisional, §11). A tool's last
 * style, which the app keeps in this browser for the tool's next drawing, is the same style.
 */

export interface DrawingTemplate {
  name: string;
  style: DrawingStyle;
}

/** One tool's templates, as the gateway serves and takes them. */
export interface ToolTemplates {
  tool: DrawingTool;
  templates: DrawingTemplate[];
}

/** Every tool's templates, as the gateway serves them: a tool without any is left out. */
export interface DrawingTemplates {
  tools: Partial<Record<DrawingTool, DrawingTemplate[]>>;
}

/** `data/drawing-templates.json`. */
export interface DrawingTemplatesFile extends DrawingTemplates {
  version: 1;
}

/** A template's name, at most this long (ours: TradingView doesn't say; provisional, §11). */
export const MAX_TEMPLATE_NAME = 64;
/** A tool's templates, at most this many: only to guard the file. */
export const MAX_TEMPLATES_PER_TOOL = 200;

/** No control characters in a name (a line break, a tab). */
const PLAIN = /^[^\p{Cc}]*$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A name as kept: trimmed, each run of spaces one space; empty when it's only spaces. */
export function templateName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The style a template, or a tool's last style, keeps: the drawing's, its text left out. */
export function styleWithoutText(style: DrawingStyle): DrawingStyle {
  const kept = copyStyle(style);
  kept.text.value = '';
  return kept;
}

/** Two plain values (as JSON holds them) alike, whatever their keys' order. */
function alike(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => alike(item, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && alike(a[key], b[key]))
  );
}

/** Whether two styles are the same, their text aside. */
export function sameStyle(a: DrawingStyle, b: DrawingStyle): boolean {
  return alike(styleWithoutText(a), styleWithoutText(b));
}

/**
 * A drawing in a template's style, or its tool's defaults ("Apply default drawing template"):
 * its own text, points, visibility, lock and place kept. The same drawing back when its style
 * is that one already.
 */
export function applyDrawingStyle(drawing: Drawing, style: DrawingStyle): Drawing {
  if (sameStyle(drawing.style, style)) return drawing;
  const next = copyStyle(style);
  next.text.value = drawing.style.text.value;
  return { ...drawing, style: next };
}

/** A tool's templates as its menu lists them: by name, case and numbers aside ("2" before "10"). */
export function sortedTemplates(templates: readonly DrawingTemplate[]): DrawingTemplate[] {
  return [...templates].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
}

/** A template as stored or sent, its style read over its tool's defaults; null if it isn't one. */
export function parseDrawingTemplate(value: unknown, tool: DrawingTool): DrawingTemplate | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.style)) return null;
  const name = templateName(value.name);
  if (name.length === 0 || name.length > MAX_TEMPLATE_NAME || !PLAIN.test(name)) return null;
  return { name, style: styleWithoutText(parseDrawingStyle(value.style, tool)) };
}

/** One tool's templates, each name once; null when they aren't valid. */
export function parseToolTemplates(value: unknown): ToolTemplates | null {
  if (!isRecord(value) || !isDrawingTool(value.tool) || !Array.isArray(value.templates)) {
    return null;
  }
  if (value.templates.length > MAX_TEMPLATES_PER_TOOL) return null;
  const { tool } = value;
  const templates: DrawingTemplate[] = [];
  const names = new Set<string>();
  for (const item of value.templates) {
    const template = parseDrawingTemplate(item, tool);
    if (!template || names.has(template.name)) return null;
    names.add(template.name);
    templates.push(template);
  }
  return { tool, templates };
}

/** Every tool's templates, a tool without any left out; null when any aren't valid. */
export function parseDrawingTemplates(value: unknown): DrawingTemplates | null {
  if (!isRecord(value) || !isRecord(value.tools)) return null;
  const tools: Partial<Record<DrawingTool, DrawingTemplate[]>> = {};
  for (const [tool, templates] of Object.entries(value.tools)) {
    const parsed = parseToolTemplates({ tool, templates });
    if (!parsed) return null;
    if (parsed.templates.length > 0) tools[parsed.tool] = parsed.templates;
  }
  return { tools };
}

export function parseDrawingTemplatesFile(value: unknown): DrawingTemplatesFile | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const parsed = parseDrawingTemplates(value);
  return parsed ? { version: 1, tools: parsed.tools } : null;
}
