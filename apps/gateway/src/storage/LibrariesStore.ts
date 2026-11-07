import { join } from 'node:path';
import {
  type LibrariesIndex,
  type LibraryRef,
  libraryPath,
  MAX_LIBRARIES,
  parseLibrariesIndex,
  parseLibraryRef,
  parseLibrarySource,
  type SavedLibrary,
  sameLibrary,
} from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from './jsonFile.ts';

interface Stored {
  version: 1;
  libraries: SavedLibrary[];
}

const EMPTY: Stored = { version: 1, libraries: [] };

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null;
  if ((value as { version?: unknown }).version !== 1) return null;
  const index = parseLibrariesIndex(value);
  return index ? { version: 1, libraries: index.libraries } : null;
}

const byPath = (a: SavedLibrary, b: SavedLibrary) =>
  libraryPath(a).localeCompare(libraryPath(b), 'en', { sensitivity: 'base' });

/**
 * The Pine libraries the user's scripts import (docs/SPEC.md §5.17), each kept by its import
 * path with the code the user pasted from its TradingView page, in `data/libraries.json`
 * (gitignored), written whole. Adding a path that's there (case aside) replaces its code.
 * Changes run one at a time, so two at once never lose either.
 */
export class LibrariesStore {
  private readonly file: JsonFile<Stored>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}, now = Date.now) {
    this.file = new JsonFile(join(dataDir, 'libraries.json'), parseStored, {
      onInvalid: (movedTo) =>
        onWarning(`The libraries file was unreadable; kept it as ${movedTo} and started fresh`),
    });
    this.now = now;
  }

  /** Every library with its code, by path. */
  index(): Promise<LibrariesIndex> {
    return this.read((stored) => ({ libraries: [...stored.libraries].sort(byPath) }));
  }

  /** Adds a library's code at its path, or replaces the code there. */
  put(params: unknown, body: unknown): Promise<SavedLibrary> {
    const ref = refOf(params);
    const source = parseLibrarySource((body as { source?: unknown } | null)?.source);
    if (source === null) throw new MarketError('bad_request', "That isn't a library's code");
    return this.change((stored) => {
      const kept = stored.libraries.filter((item) => !sameLibrary(item, ref));
      if (kept.length >= MAX_LIBRARIES) {
        throw new MarketError('bad_request', `You can keep up to ${MAX_LIBRARIES} libraries`);
      }
      const library: SavedLibrary = { ...ref, source, addedAt: this.now() };
      stored.libraries = [...kept, library];
      return library;
    });
  }

  /** Removes a library; returns the libraries left. */
  remove(params: unknown): Promise<LibrariesIndex> {
    const ref = refOf(params);
    return this.change((stored) => {
      const kept = stored.libraries.filter((item) => !sameLibrary(item, ref));
      if (kept.length === stored.libraries.length) {
        throw new MarketError('not_found', `There's no library ${libraryPath(ref)}`);
      }
      stored.libraries = kept;
      return { libraries: [...kept].sort(byPath) };
    });
  }

  private async load(): Promise<Stored> {
    return (await this.file.read()) ?? structuredClone(EMPTY);
  }

  private read<T>(view: (stored: Stored) => T): Promise<T> {
    const run = this.queue.then(async () => view(await this.load()));
    this.queue = run.catch(() => {});
    return run;
  }

  private change<T>(edit: (stored: Stored) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const stored = await this.load();
      const result = edit(stored);
      await this.file.write(stored);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** A route's `:publisher/:name/:version`, checked. */
function refOf(params: unknown): LibraryRef {
  const { publisher, name, version } = (params ?? {}) as Record<string, unknown>;
  const ref = parseLibraryRef(publisher, name, version);
  if (!ref) {
    throw new MarketError(
      'bad_request',
      'A library is named user/library/version, e.g. TradingView/ta/7',
    );
  }
  return ref;
}
