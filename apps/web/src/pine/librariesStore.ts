import { type LibraryRef, libraryPath, type SavedLibrary, sameLibrary } from '@tradingnerd/core';
import type { CompileOptions, LibraryResolver } from '@tradingnerd/pine';
import { useSyncExternalStore } from 'react';
import { ApiError, type LibrariesApi, librariesApi } from '../data/api';

/** The libraries the user's scripts import, as the editor and the chart compile with them. */
export interface LibrariesState {
  /** Every library with its code, by path; null until the gateway has answered. */
  libraries: readonly SavedLibrary[] | null;
  /** Counts each change: a script that imports compiles again when it moves on. */
  revision: number;
  /** Why loading them failed, if it did. */
  error: string | null;
}

/** What compiling a script needs of the libraries: their code, and their revision for the cache. */
export type LibraryOptions = CompileOptions & { revision: string };

/**
 * Revisions are counted across every store in the page: compileCached keys its results by the
 * revision, so two stores must never hand it the same one for different libraries.
 */
let lastRevision = 0;

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

/**
 * The Pine libraries the user's scripts import (docs/SPEC.md §5.17), their code pasted by the
 * user and kept by the gateway in `data/libraries.json`. An import finds its library by the path
 * exactly as written; adding a path that's there in another case replaces it, as the gateway
 * does, so the import's own spelling wins.
 */
export class LibrariesStore {
  private value: LibrariesState = { libraries: null, revision: 0, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly api: LibrariesApi;
  private byPath = new Map<string, string>();
  private options: LibraryOptions;

  constructor(api: LibrariesApi = librariesApi) {
    this.api = api;
    this.options = { resolveLibrary: this.resolve, revision: '0' };
  }

  get = (): LibrariesState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The code an import names, by its path as written; null if it isn't added. */
  resolve: LibraryResolver = (publisher, name, version) =>
    this.byPath.get(libraryPath({ publisher, name, version })) ?? null;

  /** The libraries' code and revision, for compileCached: the same object until they change. */
  compileOptions(): LibraryOptions {
    return this.options;
  }

  /** Loads the libraries from the gateway; without it, scripts compile without any. */
  async load(): Promise<void> {
    try {
      const { libraries } = await this.api.index();
      this.commit(libraries, null);
    } catch (error) {
      this.commit(this.value.libraries ?? [], message(error));
    }
  }

  /** Adds a library's code at its path, or replaces it; the error's words if it failed. */
  async add(ref: LibraryRef, source: string): Promise<string | null> {
    try {
      const saved = await this.api.put(ref, source);
      const others = (this.value.libraries ?? []).filter((item) => !sameLibrary(item, ref));
      this.commit([...others, saved], null);
      return null;
    } catch (error) {
      return message(error);
    }
  }

  /** Removes a library; the error's words if it failed. */
  async remove(ref: LibraryRef): Promise<string | null> {
    try {
      const { libraries } = await this.api.remove(ref);
      this.commit(libraries, null);
      return null;
    } catch (error) {
      return message(error);
    }
  }

  private commit(libraries: readonly SavedLibrary[], error: string | null): void {
    const sorted = [...libraries].sort((a, b) =>
      libraryPath(a).localeCompare(libraryPath(b), 'en', { sensitivity: 'base' }),
    );
    this.byPath = new Map(sorted.map((item) => [libraryPath(item), item.source]));
    const revision = ++lastRevision;
    this.options = { resolveLibrary: this.resolve, revision: String(revision) };
    this.value = { libraries: sorted, revision, error };
    for (const listener of this.listeners) listener();
  }
}

export const librariesStore = new LibrariesStore();

export function useLibraries(): LibrariesState {
  return useSyncExternalStore(librariesStore.subscribe, librariesStore.get);
}
