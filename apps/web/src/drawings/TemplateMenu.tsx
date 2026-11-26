import {
  type DrawingStyle,
  type DrawingTool,
  defaultDrawingStyle,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATES_PER_TOOL,
  sortedTemplates,
  templateName,
} from '@tradingnerd/core';
import { useSyncExternalStore } from 'react';
import { ConfirmDialog, ListNameDialog } from '../watchlist/ListDialogs';
import type { PopupMenuEntry } from '../watchlist/PopupMenu';
import { TEMPLATES_RETRY_MS, type TemplatesState, templateStore } from './templateStore';

/**
 * The Template menu (docs/SPEC.md §5.27, D3b), the same in its three places: the settings
 * dialog's Template button, the floating toolbar's Templates and the drawings' menu's Template ›
 * (TradingView's Help Center names the floating toolbar and the context menu): "Save drawing
 * template as…", "Apply default drawing template", then the tool's templates by name, each with
 * a ✕ that removes it. Its words are a third-party guide's ("Save Drawing Template As…") and the
 * Charting Library's action ("Apply default"); provisional until measured from a screenshot (§11).
 */

export const SAVE_TEMPLATE = 'Save drawing template as…';
export const APPLY_DEFAULT = 'Apply default drawing template';

export function templateEntries({
  tool,
  state,
  style,
  onApply,
}: {
  tool: DrawingTool;
  state: TemplatesState;
  /** The style a new template keeps: the drawing's as it is now (in a dialog, not yet kept). */
  style(): DrawingStyle;
  onApply(style: DrawingStyle): void;
}): PopupMenuEntry[] {
  const saved = sortedTemplates(state.tools[tool] ?? []);
  const full = saved.length >= MAX_TEMPLATES_PER_TOOL;
  const entries: PopupMenuEntry[] = [
    {
      label: SAVE_TEMPLATE,
      disabled: state.status !== 'ready' || full,
      onSelect: () => templateDialogs.open({ kind: 'save', tool, style: style(), name: '' }),
    },
    { label: APPLY_DEFAULT, onSelect: () => onApply(defaultDrawingStyle(tool)) },
  ];
  if (saved.length > 0) entries.push('separator');
  for (const template of saved) {
    entries.push({
      label: template.name,
      onSelect: () => onApply(template.style),
      onRemove: () => templateDialogs.open({ kind: 'remove', tool, name: template.name }),
      removeLabel: `Remove template ${template.name}`,
    });
  }
  const problem = statusLine(state);
  if (problem) entries.push('separator', { label: problem, disabled: true });
  return entries;
}

/** What keeps the templates from showing or saving now, if anything (ours, §11). */
function statusLine(state: TemplatesState): string | null {
  const again = `Trying again every ${TEMPLATES_RETRY_MS / 1000} s.`;
  if (state.status === 'idle' || state.status === 'loading') return 'Loading templates…';
  if (state.status === 'failed') return `Templates couldn’t load. ${again}`;
  if (state.saveError) return `Templates couldn’t be saved. ${again}`;
  return null;
}

/** The questions a Template menu asks once it has closed: a name, replacing one, removing one. */
export type TemplateDialog =
  | { kind: 'save'; tool: DrawingTool; style: DrawingStyle; name: string }
  | { kind: 'replace'; tool: DrawingTool; style: DrawingStyle; name: string }
  | { kind: 'remove'; tool: DrawingTool; name: string };

class TemplateDialogs {
  private value: TemplateDialog | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): TemplateDialog | null => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(dialog: TemplateDialog): void {
    this.set(dialog);
  }

  close = (): void => {
    this.set(null);
  };

  private set(value: TemplateDialog | null): void {
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The Template menus' open question: one at a time, over the chart and any dialog. */
export const templateDialogs = new TemplateDialogs();

/**
 * The open question, if any: "Save drawing template as" asks for a name, and asks before
 * replacing a template of that name (back to the name on Cancel); removing one asks first, as
 * neither can be undone (ours: TradingView's questions and their words are provisional, §11).
 */
export function TemplateDialogsHost() {
  const dialog = useSyncExternalStore(templateDialogs.subscribe, templateDialogs.get);
  if (!dialog) return null;
  const close = templateDialogs.close;
  switch (dialog.kind) {
    case 'save':
      return (
        <ListNameDialog
          title="Save drawing template as"
          action="Save"
          label="Template name"
          maxLength={MAX_TEMPLATE_NAME}
          initialName={dialog.name}
          onSubmit={(typed) => {
            const name = templateName(typed);
            if (templateStore.find(dialog.tool, name)) {
              templateDialogs.open({ ...dialog, kind: 'replace', name });
              return;
            }
            templateStore.save(dialog.tool, name, dialog.style);
            close();
          }}
          onClose={close}
        />
      );
    case 'replace':
      return (
        <ConfirmDialog
          title="Save drawing template as"
          message={`A template named “${dialog.name}” already exists. Do you want to replace it?`}
          action="Replace"
          onConfirm={() => {
            templateStore.save(dialog.tool, dialog.name, dialog.style);
            close();
          }}
          onClose={() => templateDialogs.open({ ...dialog, kind: 'save' })}
        />
      );
    case 'remove':
      return (
        <ConfirmDialog
          title="Remove drawing template"
          message={`Do you really want to remove the drawing template “${dialog.name}”?`}
          action="Remove"
          onConfirm={() => {
            templateStore.remove(dialog.tool, dialog.name);
            close();
          }}
          onClose={close}
        />
      );
  }
}
