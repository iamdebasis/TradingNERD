import type { DrawingTool } from '@tradingnerd/core';

/**
 * The drawing tools' keys (docs/SPEC.md §5.27): TradingView's ⌥T, ⌥H, ⌥J, ⌥V and ⌥C for the
 * Lines tools (the user's screenshot of its menu), Ctrl/⌘ + Z to undo and Ctrl+Y or ⌘⇧Z to redo,
 * Ctrl+Alt+H (⌘⌥H) to hide every drawing, Escape to let go and Delete (a Mac's delete key is
 * Backspace) to remove the selection.
 */
export type DrawingKeyAction =
  | { kind: 'tool'; tool: DrawingTool }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'hide-all' }
  | { kind: 'cancel' }
  | { kind: 'delete' };

/** ⌥ and a letter, read from the key's place: ⌥ changes the letter typed on a Mac. */
const ALT_TOOLS: Record<string, DrawingTool> = {
  KeyT: 'trend-line',
  KeyH: 'horizontal-line',
  KeyJ: 'horizontal-ray',
  KeyV: 'vertical-line',
  KeyC: 'cross-line',
};

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/** The letter a key types, or its place's letter when it types none (another script's). */
function letterOf(event: KeyInput): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const place = /^Key([A-Z])$/.exec(event.code);
  return place ? (place[1] as string).toLowerCase() : null;
}

export function drawingKeyAction(event: KeyInput): DrawingKeyAction | null {
  const command = event.ctrlKey || event.metaKey;
  if (event.altKey && !command && !event.shiftKey) {
    const tool = ALT_TOOLS[event.code];
    return tool ? { kind: 'tool', tool } : null;
  }
  if (event.altKey && command && !event.shiftKey) {
    return event.code === 'KeyH' ? { kind: 'hide-all' } : null;
  }
  if (command) {
    const letter = letterOf(event);
    if (letter === 'z') return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
    if (letter === 'y' && event.ctrlKey && !event.shiftKey) return { kind: 'redo' };
    return null;
  }
  if (event.shiftKey) return null;
  if (event.key === 'Escape') return { kind: 'cancel' };
  if (event.key === 'Delete' || event.key === 'Backspace') return { kind: 'delete' };
  return null;
}
