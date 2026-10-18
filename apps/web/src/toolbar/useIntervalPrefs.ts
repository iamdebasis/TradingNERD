import { useEffect, useState } from 'react';
import { readJson, writeJson } from '../lib/storage';
import { type IntervalPrefs, sanitizePrefs } from './intervalPrefs';

const STORAGE_KEY = 'tn.intervals';

/**
 * The user's interval favorites, added intervals and folded menu sections, kept across reloads
 * (best effort: without storage they last until the page closes).
 */
export function useIntervalPrefs() {
  const [prefs, setPrefs] = useState<IntervalPrefs>(() => sanitizePrefs(readJson(STORAGE_KEY)));
  useEffect(() => writeJson(STORAGE_KEY, prefs), [prefs]);
  return [prefs, setPrefs] as const;
}
