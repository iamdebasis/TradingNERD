import {
  type Drawing,
  type DrawingStyle,
  type DrawingTool,
  isDrawingTool,
  parseDrawingStyle,
  sameStyle,
  styleWithoutText,
} from '@tradingnerd/core';
import { readJson, writeJson } from '../lib/storage';

/**
 * A tool's last style (docs/SPEC.md §5.27, D3b): a new drawing starts in the style last given a
 * drawing of its tool, by the floating toolbar, the settings dialog's Ok or a template, as
 * TradingView's tools "remember previous setting" (third-party accounts only; provisional,
 * §11). Its text is left out. Kept in this browser, as TradingView's Charting Library keeps
 * chart properties in the browser's storage.
 */

/** Where the last styles are kept. */
export const LAST_STYLES_KEY = 'tn.drawings.lastStyles';

export type ToolStyleMap = Partial<Record<DrawingTool, DrawingStyle>>;

/** The kept styles, each read over its tool's defaults; none for what isn't a style. */
export function parseLastStyles(value: unknown): ToolStyleMap {
  const styles: ToolStyleMap = {};
  if (typeof value !== 'object' || value === null) return styles;
  const { version, tools } = value as { version?: unknown; tools?: unknown };
  if (version !== 1 || typeof tools !== 'object' || tools === null) return styles;
  for (const [tool, style] of Object.entries(tools)) {
    if (isDrawingTool(tool) && typeof style === 'object' && style !== null) {
      styles[tool] = styleWithoutText(parseDrawingStyle(style, tool));
    }
  }
  return styles;
}

export class ToolStyles {
  private styles: ToolStyleMap;

  constructor() {
    this.styles = parseLastStyles(readJson(LAST_STYLES_KEY));
  }

  /** The style a tool's next drawing starts with, or none for its defaults. */
  styleOf = (tool: DrawingTool): DrawingStyle | undefined => this.styles[tool];

  /** A tool's next drawing starts in this style (a template applied, or its defaults). */
  set(tool: DrawingTool, style: DrawingStyle): void {
    this.styles = { ...this.styles, [tool]: styleWithoutText(style) };
    this.write();
  }

  /**
   * After an edit: each drawing whose style it changed gives its tool's last style, the last
   * of a tool's in drawing order (the top one) when several changed. Moves, locks and
   * visibility changes leave it as it was.
   */
  remember(before: readonly Drawing[], after: readonly Drawing[]): void {
    const was = new Map(before.map((drawing) => [drawing.id, drawing]));
    let next: ToolStyleMap | null = null;
    for (const drawing of after) {
      const old = was.get(drawing.id);
      if (!old || old === drawing || sameStyle(old.style, drawing.style)) continue;
      next = { ...(next ?? this.styles), [drawing.tool]: styleWithoutText(drawing.style) };
    }
    if (!next) return;
    this.styles = next;
    this.write();
  }

  private write(): void {
    writeJson(LAST_STYLES_KEY, { version: 1, tools: this.styles });
  }
}

/** The last styles the app uses. */
export const toolStyles = new ToolStyles();
