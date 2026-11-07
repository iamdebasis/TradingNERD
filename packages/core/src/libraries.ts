import { MAX_SCRIPT_SOURCE } from './scripts.ts';

/**
 * Pine libraries the user's scripts import (docs/SPEC.md §5.17): `import user/name/version`
 * (Pine docs, Libraries). TradingView keeps libraries on its servers; we never fetch from it
 * (SPEC §3, 31 October), so each library's code is pasted by the user from its TradingView page
 * and kept by the gateway in `data/libraries.json`. Nothing leaves the Mac.
 */

export const MAX_LIBRARIES = 500;
/** A user's or a library's name in an import path, at most this long. */
export const MAX_LIBRARY_PART = 64;

/** Where a library is imported from: `publisher/name/version`. */
export interface LibraryRef {
  /** The TradingView user who published it ("TradingView", "PineCoders"). */
  publisher: string;
  /** Its name in the import: its library() title. */
  name: string;
  /** Its publication's version, from 1: an import names one, never "the latest". */
  version: number;
}

/** A library as kept: where it's imported from, its code, and when it was added. */
export interface SavedLibrary extends LibraryRef {
  source: string;
  /** When its code was added or last replaced, UTC ms. */
  addedAt: number;
}

/**
 * Body of GET /api/libraries: every library with its code, by path. The editor and the chart
 * compile scripts at once, so the code is at hand before any script imports it.
 */
export interface LibrariesIndex {
  libraries: SavedLibrary[];
}

/** Body of PUT /api/libraries/:publisher/:name/:version: the library's code. */
export interface LibraryBody {
  source: string;
}

/** "publisher/name/version", as an import writes it. */
export const libraryPath = (ref: LibraryRef): string =>
  `${ref.publisher}/${ref.name}/${ref.version}`;

const PART = /^[A-Za-z0-9_.-]+$/;

const isPart = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_LIBRARY_PART &&
  PART.test(value) &&
  value !== '.' &&
  value !== '..';

const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1e9;

/** A library's place from its parts (a version as a number or its digits); null if malformed. */
export function parseLibraryRef(
  publisher: unknown,
  name: unknown,
  version: unknown,
): LibraryRef | null {
  const number =
    typeof version === 'string' && /^\d{1,9}$/.test(version) ? Number(version) : version;
  if (!isPart(publisher) || !isPart(name) || !isVersion(number)) return null;
  return { publisher, name, version: number };
}

/** "user/name/version", as typed (spaces around it ignored); null if it isn't one. */
export function parseLibraryPath(value: unknown): LibraryRef | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('/');
  return parts.length === 3 ? parseLibraryRef(parts[0], parts[1], parts[2]) : null;
}

/** A library's code; null if not text, empty, or too long. */
export function parseLibrarySource(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_SCRIPT_SOURCE
    ? value
    : null;
}

/** A kept library; null if malformed. */
export function parseSavedLibrary(value: unknown): SavedLibrary | null {
  if (typeof value !== 'object' || value === null) return null;
  const { publisher, name, version, source, addedAt } = value as Record<string, unknown>;
  const ref = parseLibraryRef(publisher, name, version);
  const code = parseLibrarySource(source);
  if (!ref || code === null) return null;
  if (typeof addedAt !== 'number' || !Number.isFinite(addedAt) || addedAt < 0) return null;
  return { ...ref, source: code, addedAt };
}

/** The libraries, each path once; null if malformed. */
export function parseLibrariesIndex(value: unknown): LibrariesIndex | null {
  if (typeof value !== 'object' || value === null) return null;
  const { libraries } = value as Record<string, unknown>;
  if (!Array.isArray(libraries) || libraries.length > MAX_LIBRARIES) return null;
  const parsed: SavedLibrary[] = [];
  const paths = new Set<string>();
  for (const item of libraries) {
    const library = parseSavedLibrary(item);
    if (!library) return null;
    const path = libraryPath(library).toLowerCase();
    if (paths.has(path)) return null;
    paths.add(path);
    parsed.push(library);
  }
  return { libraries: parsed };
}

/** The same place, as TradingView's user names and titles compare (case aside). */
export const sameLibrary = (a: LibraryRef, b: LibraryRef): boolean =>
  libraryPath(a).toLowerCase() === libraryPath(b).toLowerCase();
