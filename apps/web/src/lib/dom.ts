/** Whether keystrokes on `target` belong to it (a text field) rather than to the chart. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    return true;
  }
  // A code editor typing through the browser's EditContext (Monaco, the Pine Editor, in Chrome):
  // an element of its own, neither a text field nor contenteditable.
  return (
    (target as HTMLElement & { editContext?: unknown }).editContext != null ||
    target.closest('.monaco-editor') !== null
  );
}
