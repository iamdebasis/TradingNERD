/**
 * Which keyboard the user has: a Mac's (⌘ and ⌥) or another's (Ctrl and Alt), for the shortcut
 * text tooltips and menus show. The shortcuts themselves work with both everywhere.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

/** An Alt (⌥) shortcut as TradingView's menus write it: "⌥ T" on a Mac, "Alt + T" elsewhere. */
export function altShortcut(key: string, mac = isMac()): string {
  return mac ? `⌥ ${key}` : `Alt + ${key}`;
}

/** A Ctrl (⌘) shortcut: "⌘Z" on a Mac, "Ctrl+Z" elsewhere; `shift` adds Shift (⇧). */
export function commandShortcut(key: string, shift = false, mac = isMac()): string {
  if (mac) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/**
 * Clone's drag as TradingView's menus write it: "⌘Drag" on a Mac (its blog GIF of February 2020),
 * "Ctrl+Drag" elsewhere, as Copy's "Ctrl+C" here (TradingView's own: "Ctrl + Drag").
 */
export function dragShortcut(mac = isMac()): string {
  return mac ? '⌘Drag' : 'Ctrl+Drag';
}
