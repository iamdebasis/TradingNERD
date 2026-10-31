/**
 * The user's Pine scripts, as TradingView keeps them in "My scripts" (docs/SPEC.md §5.16): each
 * with a name of its own, apart from its indicator() title, and every save kept as a version,
 * numbered from 1 (TradingView's Help Center, "How to apply an older version of an indicator").
 * The gateway keeps them in `data/scripts.json`; nothing leaves the Mac.
 */

export const MAX_SCRIPTS = 500;
export const MAX_SCRIPT_NAME = 64;
/** Characters of code a script may have: well past any indicator we know of. */
export const MAX_SCRIPT_SOURCE = 256_000;
/** Versions kept per script; the oldest beyond this are let go (provisional, §11). */
export const MAX_SCRIPT_VERSIONS = 1_000;

/** The built-ins a script's code can start from (packages/indicators' kinds). */
export const SCRIPT_ORIGINS = ['rsi', 'volume'] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

/** One save of a script. */
export interface ScriptVersion {
  /** 1 for the first save, then one more for each. */
  version: number;
  /** When it was saved, UTC ms. */
  savedAt: number;
}

/** One line of My scripts. */
export interface ScriptSummary {
  /** Stable id: "s-" and lowercase letters and digits. */
  id: string;
  name: string;
  /** The built-in its code started from, or null. */
  from: ScriptOrigin | null;
  /** Its latest version's number and save time. */
  version: number;
  savedAt: number;
}

/** Body of GET /api/scripts: My scripts, the latest saved first. */
export interface ScriptsIndex {
  scripts: ScriptSummary[];
}

/** Body of GET, POST and PUT /api/scripts/:id: a script's latest code and its versions. */
export interface SavedScript extends ScriptSummary {
  source: string;
  /** Every version, oldest first. */
  versions: ScriptVersion[];
}

/** Body of GET /api/scripts/:id/versions/:version: one version's code. */
export interface ScriptVersionSource extends ScriptVersion {
  source: string;
}

/** Body of POST /api/scripts: a new script. */
export interface NewScript {
  name: string;
  source: string;
  from: ScriptOrigin | null;
}

export const isScriptId = (value: unknown): value is string =>
  typeof value === 'string' && /^s-[a-z0-9]{1,32}$/.test(value);

/** A script's name, trimmed; null if empty or too long. */
export function parseScriptName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_SCRIPT_NAME ? name : null;
}

/** Code as typed (line ends as they came); null if not text or too long. */
export function parseScriptSource(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_SCRIPT_SOURCE ? value : null;
}

export const parseScriptOrigin = (value: unknown): ScriptOrigin | null | undefined => {
  if (value === null || value === undefined) return null;
  return (SCRIPT_ORIGINS as readonly unknown[]).includes(value)
    ? (value as ScriptOrigin)
    : undefined;
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A new script's name, code and origin; null if any is malformed. */
export function parseNewScript(value: unknown): NewScript | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const name = parseScriptName(raw.name);
  const source = parseScriptSource(raw.source);
  const from = parseScriptOrigin(raw.from);
  if (name === null || source === null || from === undefined) return null;
  return { name, source, from };
}

/** One line of My scripts; null if malformed. */
export function parseScriptSummary(value: unknown): ScriptSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, name, from, version, savedAt } = value as Record<string, unknown>;
  const parsedName = parseScriptName(name);
  const origin = parseScriptOrigin(from);
  if (!isScriptId(id) || parsedName === null || origin === undefined) return null;
  if (!isCount(version) || !isTime(savedAt)) return null;
  return { id, name: parsedName, from: origin, version, savedAt };
}

export function parseScriptsIndex(value: unknown): ScriptsIndex | null {
  if (typeof value !== 'object' || value === null) return null;
  const { scripts } = value as Record<string, unknown>;
  if (!Array.isArray(scripts)) return null;
  const parsed: ScriptSummary[] = [];
  for (const item of scripts) {
    const summary = parseScriptSummary(item);
    if (!summary) return null;
    parsed.push(summary);
  }
  return { scripts: parsed };
}

/** A version's number and time; null if malformed. */
export function parseScriptVersion(value: unknown): ScriptVersion | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, savedAt } = value as Record<string, unknown>;
  return isCount(version) && isTime(savedAt) ? { version, savedAt } : null;
}

/** A saved script with its versions, numbered 1, 2, 3 … in order; null if malformed. */
export function parseSavedScript(value: unknown): SavedScript | null {
  const summary = parseScriptSummary(value);
  if (!summary) return null;
  const { source, versions } = value as Record<string, unknown>;
  const code = parseScriptSource(source);
  if (code === null || !Array.isArray(versions) || versions.length === 0) return null;
  const parsed: ScriptVersion[] = [];
  for (const item of versions) {
    const version = parseScriptVersion(item);
    const before = parsed.at(-1);
    if (!version || (before && version.version <= before.version)) return null;
    parsed.push(version);
  }
  const last = parsed.at(-1) as ScriptVersion;
  if (last.version !== summary.version || last.savedAt !== summary.savedAt) return null;
  return { ...summary, source: code, versions: parsed };
}

export function parseScriptVersionSource(value: unknown): ScriptVersionSource | null {
  const version = parseScriptVersion(value);
  if (!version) return null;
  const source = parseScriptSource((value as Record<string, unknown>).source);
  return source === null ? null : { ...version, source };
}

/** A name not taken yet: the name itself, or with " 2", " 3" … after it (as copies are named). */
export function uniqueScriptName(name: string, taken: readonly string[]): string {
  const names = new Set(taken.map((item) => item.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${name.slice(0, MAX_SCRIPT_NAME - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}
