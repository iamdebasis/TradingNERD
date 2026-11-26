export interface KeyboardActions {
  /** Auto-scale on, default zoom, scrolled to the latest bar. */
  reset(): void;
  /** Zoom by notches, right edge fixed: +1 in, -1 out. */
  zoom(notches: number): void;
  /** Scroll by whole bars: negative toward older bars. */
  scrollBars(bars: number): void;
  /**
   * The plain arrows move the drawings selected, when there are some (D3a: a bar across, a pixel
   * up or down): true when they took the key, which then doesn't scroll the chart.
   */
  nudge?(bars: number, dy: number): boolean;
}

/** Bars moved by Ctrl/⌘ + ←/→ ("move further" in TradingView's shortcut list). */
export const FAST_SCROLL_BARS = 10;

/**
 * TradingView's chart navigation keys (Charting Library shortcut list): ←/→ move one bar,
 * Ctrl/⌘ + ←/→ move further, Ctrl/⌘ + ↑/↓ zoom, Alt + R resets the chart. With drawings
 * selected, the plain arrows move them instead ("Move selected drawing left", and so on).
 */
export function installKeyboard(actions: KeyboardActions, target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isEditable(event.target)) return;
    const command = event.ctrlKey || event.metaKey;
    if (event.altKey && !command && !event.shiftKey && event.code === 'KeyR') {
      event.preventDefault();
      actions.reset();
      return;
    }
    if (event.altKey || event.shiftKey) return;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        if (!command) {
          if (actions.nudge?.(0, event.key === 'ArrowUp' ? -1 : 1)) event.preventDefault();
          return;
        }
        event.preventDefault();
        actions.zoom(event.key === 'ArrowUp' ? 1 : -1);
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault(); // also stops ⌘←/⌘→ from navigating the browser history
        if (!command && actions.nudge?.(event.key === 'ArrowLeft' ? -1 : 1, 0)) return;
        const step = command ? FAST_SCROLL_BARS : 1;
        actions.scrollBars(event.key === 'ArrowLeft' ? -step : step);
        return;
      }
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    return true;
  }
  // A code editor typing through the browser's EditContext (Monaco, the Pine Editor, in Chrome).
  return (
    (target as HTMLElement & { editContext?: unknown }).editContext != null ||
    target.closest('.monaco-editor') !== null
  );
}
