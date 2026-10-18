// localStorage can be missing or throw (private windows, blocked site data), so layout
// preferences are best-effort: reads fall back to defaults and failed writes are ignored.

export function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage unavailable: the preference just won't survive a reload.
  }
}
