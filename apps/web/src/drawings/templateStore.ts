import {
  type DrawingStyle,
  type DrawingTemplate,
  type DrawingTool,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATES_PER_TOOL,
  sortedTemplates,
  styleWithoutText,
  templateName,
} from '@tradingnerd/core';
import { useSyncExternalStore } from 'react';
import { type DrawingTemplatesApi, drawingTemplatesApi } from '../data/api';

/**
 * The user's drawing templates (docs/SPEC.md §5.27, D3b): every tool's loaded from the gateway
 * once, a tool's whole list saved there after each change, one save at a time. Nothing is saved
 * before the stored templates are in, so a save never writes over ones not yet loaded. A load
 * or save that fails is tried again every TEMPLATES_RETRY_MS, the menus saying so meanwhile.
 */

/** A failed load or save is tried again this long after (as the drawings'). */
export const TEMPLATES_RETRY_MS = 3_000;

/** Runs `run` after `ms`; the function it returns cancels it. */
export type Later = (run: () => void, ms: number) => () => void;

const later: Later = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export interface TemplatesState {
  /** Loading until the gateway answers; failed when it couldn't; ready once it has. */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  tools: Partial<Record<DrawingTool, readonly DrawingTemplate[]>>;
  /** Why the templates couldn't load, or null; tried again meanwhile. */
  loadError: string | null;
  /** Why the last save failed, or null once one is made; tried again meanwhile. */
  saveError: string | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class TemplateStore {
  private value: TemplatesState = { status: 'idle', tools: {}, loadError: null, saveError: null };
  private readonly listeners = new Set<() => void>();
  private readonly api: Pick<DrawingTemplatesApi, 'load' | 'save'>;
  private readonly later: Later;
  /** The latest list to save for each tool, saved one at a time. */
  private readonly pending = new Map<DrawingTool, readonly DrawingTemplate[]>();
  /** Lists whose save failed, nothing newer having come for their tool: tried again later. */
  private readonly unsaved = new Map<DrawingTool, readonly DrawingTemplate[]>();
  private saving: Promise<void> | null = null;
  private cancelLoadRetry: (() => void) | null = null;
  private cancelSaveRetry: (() => void) | null = null;

  constructor(
    api: Pick<DrawingTemplatesApi, 'load' | 'save'> = drawingTemplatesApi,
    schedule = later,
  ) {
    this.api = api;
    this.later = schedule;
  }

  get = (): TemplatesState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Loads the templates, once: again only after a failed load. */
  async load(): Promise<void> {
    if (this.value.status === 'loading' || this.value.status === 'ready') return;
    this.cancelLoadRetry?.();
    this.cancelLoadRetry = null;
    this.commit({ ...this.value, status: 'loading' });
    try {
      const loaded = await this.api.load();
      this.commit({ ...this.value, status: 'ready', tools: loaded.tools, loadError: null });
    } catch (error) {
      this.commit({ ...this.value, status: 'failed', loadError: message(error) });
      this.cancelLoadRetry = this.later(() => {
        this.cancelLoadRetry = null;
        void this.load();
      }, TEMPLATES_RETRY_MS);
    }
  }

  /** A tool's templates, as its menu lists them (by name). */
  templatesOf(tool: DrawingTool): DrawingTemplate[] {
    return sortedTemplates(this.value.tools[tool] ?? []);
  }

  /** The template of this name (as names are kept: trimmed), if the tool has one. */
  find(tool: DrawingTool, name: string): DrawingTemplate | undefined {
    const kept = templateName(name);
    return this.value.tools[tool]?.find((template) => template.name === kept);
  }

  /** Whether a name can be saved for the tool now: loaded, and the name or room for it. */
  canSave(tool: DrawingTool, name: string): boolean {
    const kept = templateName(name);
    if (this.value.status !== 'ready' || kept.length === 0) return false;
    if (kept.length > MAX_TEMPLATE_NAME) return false;
    const count = this.value.tools[tool]?.length ?? 0;
    return count < MAX_TEMPLATES_PER_TOOL || this.find(tool, kept) !== undefined;
  }

  /**
   * Saves a style under a name for a tool, its text left out: a template of that name is
   * replaced in its place (the caller asks first), else the new one comes last. False when it
   * can't be saved now (see canSave).
   */
  save(tool: DrawingTool, name: string, style: DrawingStyle): boolean {
    if (!this.canSave(tool, name)) return false;
    const template = { name: templateName(name), style: styleWithoutText(style) };
    const list = this.value.tools[tool] ?? [];
    const at = list.findIndex((item) => item.name === template.name);
    const next = at < 0 ? [...list, template] : list.map((item, i) => (i === at ? template : item));
    this.change(tool, next);
    return true;
  }

  /** Removes a tool's template of this name. */
  remove(tool: DrawingTool, name: string): void {
    if (this.value.status !== 'ready') return;
    const list = this.value.tools[tool] ?? [];
    const kept = templateName(name);
    const next = list.filter((item) => item.name !== kept);
    if (next.length !== list.length) this.change(tool, next);
  }

  /** Every save asked for so far has been made (or has failed, to be tried again later). */
  async whenSaved(): Promise<void> {
    while (this.saving) await this.saving;
  }

  private change(tool: DrawingTool, templates: readonly DrawingTemplate[]): void {
    const tools = { ...this.value.tools };
    if (templates.length > 0) tools[tool] = templates;
    else delete tools[tool];
    this.commit({ ...this.value, tools });
    this.pending.set(tool, templates);
    // The newest list takes the place of one whose save failed.
    this.unsaved.delete(tool);
    this.drainSoon();
  }

  private drainSoon(): void {
    this.saving ??= this.drain().finally(() => {
      this.saving = null;
      if (this.pending.size > 0) this.drainSoon();
    });
  }

  private async drain(): Promise<void> {
    for (let next = this.pending.entries().next(); !next.done; ) {
      const [tool, templates] = next.value;
      this.pending.delete(tool);
      try {
        await this.api.save({ tool, templates: templates.slice() });
        if (this.value.saveError !== null && this.unsaved.size === 0) {
          this.commit({ ...this.value, saveError: null });
        }
      } catch (error) {
        // Kept to be tried again, unless a newer list for the tool came meanwhile.
        if (!this.pending.has(tool)) this.unsaved.set(tool, templates);
        this.commit({ ...this.value, saveError: message(error) });
        this.retrySaves();
      }
      next = this.pending.entries().next();
    }
  }

  /** The failed saves go again after TEMPLATES_RETRY_MS. */
  private retrySaves(): void {
    if (this.cancelSaveRetry) return;
    this.cancelSaveRetry = this.later(() => {
      this.cancelSaveRetry = null;
      for (const [tool, templates] of this.unsaved) {
        if (!this.pending.has(tool)) this.pending.set(tool, templates);
      }
      this.unsaved.clear();
      this.drainSoon();
    }, TEMPLATES_RETRY_MS);
  }

  private commit(next: TemplatesState): void {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The templates the app uses. */
export const templateStore = new TemplateStore();

/** The templates; re-renders when they change. */
export function useTemplates(): TemplatesState {
  return useSyncExternalStore(templateStore.subscribe, templateStore.get);
}
