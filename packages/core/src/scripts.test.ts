import { describe, expect, it } from 'vitest';
import {
  isScriptId,
  MAX_SCRIPT_NAME,
  MAX_SCRIPT_SOURCE,
  parseNewScript,
  parseSavedScript,
  parseScriptName,
  parseScriptsIndex,
  parseScriptVersionSource,
  uniqueScriptName,
} from './scripts.ts';

const SAVED = {
  id: 's-abc123',
  name: 'My RSI',
  from: 'rsi',
  version: 2,
  savedAt: 2_000,
  source: '//@version=6\nindicator("My RSI")\nplot(close)',
  versions: [
    { version: 1, savedAt: 1_000 },
    { version: 2, savedAt: 2_000 },
  ],
};

describe('Pine scripts on the wire', () => {
  it('takes a new script’s name, code and origin, trimming the name', () => {
    expect(parseNewScript({ name: '  My RSI ', source: 'plot(close)', from: 'rsi' })).toEqual({
      name: 'My RSI',
      source: 'plot(close)',
      from: 'rsi',
    });
    expect(parseNewScript({ name: 'Mine', source: '' })).toEqual({
      name: 'Mine',
      source: '',
      from: null,
    });
  });

  it('refuses empty or long names, code that isn’t text or is too long, and unknown origins', () => {
    expect(parseScriptName('   ')).toBeNull();
    expect(parseScriptName('x'.repeat(MAX_SCRIPT_NAME + 1))).toBeNull();
    expect(parseNewScript({ name: 'A', source: 42 })).toBeNull();
    expect(parseNewScript({ name: 'A', source: 'x'.repeat(MAX_SCRIPT_SOURCE + 1) })).toBeNull();
    expect(parseNewScript({ name: 'A', source: '', from: 'macd' })).toBeNull();
  });

  it('reads a saved script, its versions numbered in order and the last its own', () => {
    expect(parseSavedScript(SAVED)).toEqual(SAVED);
    expect(parseSavedScript({ ...SAVED, versions: [...SAVED.versions].reverse() })).toBeNull();
    expect(parseSavedScript({ ...SAVED, version: 3 })).toBeNull();
    expect(parseSavedScript({ ...SAVED, versions: [] })).toBeNull();
    expect(parseSavedScript({ ...SAVED, id: 'watchlist' })).toBeNull();
  });

  it('reads My scripts and a version’s code', () => {
    const { source: _source, versions: _versions, ...summary } = SAVED;
    expect(parseScriptsIndex({ scripts: [summary] })).toEqual({ scripts: [summary] });
    expect(parseScriptsIndex({ scripts: [{ ...summary, version: 0 }] })).toBeNull();
    expect(parseScriptVersionSource({ version: 1, savedAt: 1_000, source: 'plot(1)' })).toEqual({
      version: 1,
      savedAt: 1_000,
      source: 'plot(1)',
    });
  });

  it('knows its ids', () => {
    expect(isScriptId('s-k2j4')).toBe(true);
    expect(isScriptId('S-K2J4')).toBe(false);
    expect(isScriptId('s-')).toBe(false);
  });

  it('numbers a name already taken, whatever its case', () => {
    expect(uniqueScriptName('My RSI', ['Other'])).toBe('My RSI');
    expect(uniqueScriptName('My RSI', ['my rsi', 'My RSI 2'])).toBe('My RSI 3');
    expect(
      uniqueScriptName('x'.repeat(MAX_SCRIPT_NAME), ['x'.repeat(MAX_SCRIPT_NAME)]),
    ).toHaveLength(MAX_SCRIPT_NAME);
  });
});
