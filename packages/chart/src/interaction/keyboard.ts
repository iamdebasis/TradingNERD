export interface KeyboardActions {
  /** Auto-scale on, default zoom, scrolled to the latest bar. */
  reset(): void;
  /** Zoom by notches, right edge fixed: +1 in, -1 out. */
  zoom(notches: number): void;
  /** Scroll by whole bars: negative toward older bars. */
  scrollBars(bars: number): void;
}

/** Bars moved by Ctrl/⌘ + ←/→ ("move further" in TradingView's shortcut list). */
export const FAST_SCROLL_BARS = 10;

/**
 * TradingView's chart navigation keys (Charting Library shortcut list): ←/→ move one bar,
 * Ctrl/⌘ + ←/→ move further, Ctrl/⌘ + ↑/↓ zoom, Alt + R resets the chart.
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
        if (!command) return;
        event.preventDefault();
        actions.zoom(event.key === 'ArrowUp' ? 1 : -1);
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault(); // also stops ⌘←/⌘→ from navigating the browser history
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
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
