import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  isScriptId,
  MAX_SCRIPT_VERSIONS,
  MAX_SCRIPTS,
  parseNewScript,
  parseScriptName,
  parseScriptOrigin,
  parseScriptSource,
  type SavedScript,
  type ScriptOrigin,
  type ScriptSummary,
  type ScriptsIndex,
  type ScriptVersionSource,
  uniqueScriptName,
} from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from './jsonFile.ts';

interface StoredVersion {
  version: number;
  savedAt: number;
  source: string;
}

interface StoredScript {
  id: string;
  name: string;
  from: ScriptOrigin | null;
  /** Oldest first; the last is the script's code now. */
  versions: StoredVersion[];
}

interface Stored {
  version: 1;
  scripts: StoredScript[];
}

const EMPTY: Stored = { version: 1, scripts: [] };

function parseStoredVersion(value: unknown): StoredVersion | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, savedAt, source } = value as Record<string, unknown>;
  const code = parseScriptSource(source);
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || code === null) return null;
  return { version, savedAt, source: code };
}

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, scripts } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(scripts) || scripts.length > MAX_SCRIPTS) return null;
  const parsed: StoredScript[] = [];
  const ids = new Set<string>();
  for (const item of scripts) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, name, from, versions } = item as Record<string, unknown>;
    const scriptName = parseScriptName(name);
    const origin = parseScriptOrigin(from);
    if (!isScriptId(id) || ids.has(id) || scriptName === null || origin === undefined) return null;
    if (!Array.isArray(versions) || versions.length === 0) return null;
    const kept: StoredVersion[] = [];
    for (const raw of versions) {
      const stored = parseStoredVersion(raw);
      const before = kept.at(-1);
      if (!stored || (before && stored.version <= before.version)) return null;
      kept.push(stored);
    }
    ids.add(id);
    parsed.push({ id, name: scriptName, from: origin, versions: kept });
  }
  return { version: 1, scripts: parsed };
}

const latest = (script: StoredScript) => script.versions.at(-1) as StoredVersion;

const summaryOf = (script: StoredScript): ScriptSummary => ({
  id: script.id,
  name: script.name,
  from: script.from,
  version: latest(script).version,
  savedAt: latest(script).savedAt,
});

const savedOf = (script: StoredScript): SavedScript => ({
  ...summaryOf(script),
  source: latest(script).source,
  versions: script.versions.map(({ version, savedAt }) => ({ version, savedAt })),
});

const newId = () => `s-${randomBytes(6).toString('hex')}`;

/**
 * The user's Pine scripts, TradingView's "My scripts" (docs/SPEC.md §5.16), kept by the gateway in
 * `data/scripts.json` (gitignored), written whole. Every save that changes the code is a new
 * version; one that doesn't is no new version, as TradingView's Save does nothing then. Changes
 * run one at a time, so two at once never lose either.
 */
export class ScriptsStore {
  private readonly file: JsonFile<Stored>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}, now = Date.now) {
    this.file = new JsonFile(join(dataDir, 'scripts.json'), parseStored, {
      onInvalid: (movedTo) =>
        onWarning(`The scripts file was unreadable; kept it as ${movedTo} and started fresh`),
    });
    this.now = now;
  }

  /** My scripts, the latest saved first. */
  index(): Promise<ScriptsIndex> {
    return this.read((stored) => ({
      scripts: stored.scripts.map(summaryOf).sort((a, b) => b.savedAt - a.savedAt),
    }));
  }

  get(id: string): Promise<SavedScript> {
    return this.read((stored) => savedOf(this.find(stored, id)));
  }

  /** One version's code. */
  version(id: string, version: number): Promise<ScriptVersionSource> {
    return this.read((stored) => {
      const found = this.find(stored, id).versions.find((item) => item.version === version);
      if (!found)
        throw new MarketError('not_found', `There's no version ${version} of that script`);
      return { ...found };
    });
  }

  /** A new script, saved as its version 1; a name already taken gets a number after it. */
  create(body: unknown): Promise<SavedScript> {
    const script = parseNewScript(body);
    if (!script) throw new MarketError('bad_request', 'That is not a script to save');
    return this.change((stored) => {
      if (stored.scripts.length >= MAX_SCRIPTS) {
        throw new MarketError('bad_request', `You can keep up to ${MAX_SCRIPTS} scripts`);
      }
      const name = uniqueScriptName(
        script.name,
        stored.scripts.map((item) => item.name),
      );
      const created: StoredScript = {
        id: newId(),
        name,
        from: script.from,
        versions: [{ version: 1, savedAt: this.now(), source: script.source }],
      };
      stored.scripts.push(created);
      return savedOf(created);
    });
  }

  /** Saves new code as the next version (none when it's the same code). */
  save(id: string, body: unknown): Promise<SavedScript> {
    const source = parseScriptSource((body as { source?: unknown } | null)?.source);
    if (source === null) throw new MarketError('bad_request', 'That is not code to save');
    return this.change((stored) => {
      const script = this.find(stored, id);
      const last = latest(script);
      if (last.source === source) return savedOf(script);
      script.versions.push({ version: last.version + 1, savedAt: this.now(), source });
      // Very old versions go once a script has many (provisional, docs/SPEC.md §11).
      if (script.versions.length > MAX_SCRIPT_VERSIONS) {
        script.versions.splice(0, script.versions.length - MAX_SCRIPT_VERSIONS);
      }
      return savedOf(script);
    });
  }

  /** Renames a script; its versions stay as they are. */
  rename(id: string, body: unknown): Promise<SavedScript> {
    const name = parseScriptName((body as { name?: unknown } | null)?.name);
    if (name === null) throw new MarketError('bad_request', 'That is not a script name');
    return this.change((stored) => {
      const script = this.find(stored, id);
      script.name = uniqueScriptName(
        name,
        stored.scripts.filter((item) => item !== script).map((item) => item.name),
      );
      return savedOf(script);
    });
  }

  /** Deletes a script and every version of it; returns My scripts after. */
  remove(id: string): Promise<ScriptsIndex> {
    return this.change((stored) => {
      const script = this.find(stored, id);
      stored.scripts = stored.scripts.filter((item) => item !== script);
      return {
        scripts: stored.scripts.map(summaryOf).sort((a, b) => b.savedAt - a.savedAt),
      };
    });
  }

  private find(stored: Stored, id: string): StoredScript {
    const script = isScriptId(id) ? stored.scripts.find((item) => item.id === id) : undefined;
    if (!script) throw new MarketError('not_found', 'There is no such script');
    return script;
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
