import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LIBRARIES, parseLibrariesIndex, parseSavedLibrary } from '@tradingnerd/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketError } from '../src/market/types.ts';
import { registerLibraryRoutes } from '../src/routes/libraries.ts';
import { LibrariesStore } from '../src/storage/LibrariesStore.ts';

const HLM = '//@version=5\nlibrary("lib_hlm")\nexport hl2(float h, float l) => (h + l) / 2';
const HLM_2 = '//@version=5\nlibrary("lib_hlm")\nexport hl2(float h, float l) => h / 2 + l / 2';
const TA = '//@version=6\nlibrary("ta")\nexport double(float x) => 2 * x';
const ref = { publisher: 'JollyWizard', name: 'lib_hlm', version: '1' };

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'tradingnerd-libraries-')), 'data');

/** A store whose clock moves on a second at each change. */
function store(dataDir = freshDir()): { libraries: LibrariesStore; dataDir: string } {
  let now = 1_700_000_000_000;
  return {
    libraries: new LibrariesStore(
      dataDir,
      () => {},
      () => (now += 1_000),
    ),
    dataDir,
  };
}

describe('Libraries, kept in data/libraries.json', () => {
  it('keeps a library’s code at its import path', async () => {
    const { libraries, dataDir } = store();
    const saved = await libraries.put(ref, { source: HLM });
    expect(parseSavedLibrary(saved)).toEqual(saved);
    expect(saved).toMatchObject({
      publisher: 'JollyWizard',
      name: 'lib_hlm',
      version: 1,
      source: HLM,
    });
    const file = JSON.parse(readFileSync(join(dataDir, 'libraries.json'), 'utf8'));
    expect(file).toMatchObject({ version: 1, libraries: [{ name: 'lib_hlm', source: HLM }] });
  });

  it('replaces the code at a path already there, its case aside, and keeps other versions', async () => {
    const { libraries } = store();
    await libraries.put(ref, { source: HLM });
    await libraries.put({ ...ref, version: '2' }, { source: HLM_2 });
    await libraries.put({ ...ref, publisher: 'jollywizard' }, { source: HLM_2 });
    const { libraries: kept } = await libraries.index();
    expect(kept.map((item) => [item.publisher, item.version, item.source])).toEqual([
      ['jollywizard', 1, HLM_2],
      ['JollyWizard', 2, HLM_2],
    ]);
  });

  it('lists them by path, with their code', async () => {
    const { libraries } = store();
    await libraries.put(ref, { source: HLM });
    await libraries.put({ publisher: 'TradingView', name: 'ta', version: '7' }, { source: TA });
    const index = await libraries.index();
    expect(parseLibrariesIndex(index)).toEqual(index);
    expect(index.libraries.map((item) => item.name)).toEqual(['lib_hlm', 'ta']);
  });

  it('removes one, and says when there was none', async () => {
    const { libraries } = store();
    await libraries.put(ref, { source: HLM });
    expect(await libraries.remove(ref)).toEqual({ libraries: [] });
    await expect(libraries.remove(ref)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a malformed path and code that isn’t text', async () => {
    const { libraries } = store();
    for (const bad of [
      { ...ref, version: '0' },
      { ...ref, version: 'x' },
      { ...ref, publisher: 'a b' },
      { ...ref, name: '..' },
      { ...ref, name: 'x'.repeat(65) },
    ]) {
      expect(() => libraries.put(bad, { source: HLM })).toThrow(MarketError);
    }
    expect(() => libraries.put(ref, { source: '  ' })).toThrow(MarketError);
    expect(() => libraries.put(ref, { source: 42 })).toThrow(MarketError);
  });

  it('keeps up to its limit of libraries', async () => {
    const { libraries } = store();
    for (let version = 1; version <= MAX_LIBRARIES; version++) {
      await libraries.put({ ...ref, version: String(version) }, { source: HLM });
    }
    await expect(
      libraries.put({ ...ref, version: String(MAX_LIBRARIES + 1) }, { source: HLM }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    // Replacing one that's there is still fine.
    await libraries.put(ref, { source: HLM_2 });
  });

  it('runs changes one at a time, so two at once keep both', async () => {
    const { libraries } = store();
    await Promise.all([
      libraries.put(ref, { source: HLM }),
      libraries.put({ ...ref, version: '2' }, { source: HLM_2 }),
    ]);
    expect((await libraries.index()).libraries).toHaveLength(2);
  });

  it('moves an unreadable file aside instead of losing it', async () => {
    const dataDir = freshDir();
    const { libraries } = store(dataDir);
    await libraries.put(ref, { source: HLM });
    writeFileSync(join(dataDir, 'libraries.json'), '{ broken');
    const warnings: string[] = [];
    const reopened = new LibrariesStore(dataDir, (message) => warnings.push(message));
    expect((await reopened.index()).libraries).toEqual([]);
    expect(readdirSync(dataDir).some((name) => name.startsWith('libraries.json.invalid-'))).toBe(
      true,
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('The libraries routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const code = error instanceof MarketError ? error.code : 'internal_error';
      reply
        .code(code === 'not_found' ? 404 : code === 'bad_request' ? 400 : 500)
        .send({ error: code });
    });
    registerLibraryRoutes(app, store().libraries);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('add, list and remove', async () => {
    const url = '/api/libraries/JollyWizard/lib_hlm/1';
    const added = (await call('PUT', url, { source: HLM })).json();
    expect(added).toMatchObject({ publisher: 'JollyWizard', name: 'lib_hlm', version: 1 });
    expect((await call('GET', '/api/libraries')).json().libraries).toEqual([added]);
    expect((await call('DELETE', url)).json()).toEqual({ libraries: [] });
  });

  it.each([
    ['a version that isn’t a number', 'PUT', '/api/libraries/a/b/x', { source: HLM }, 400],
    ['no code', 'PUT', '/api/libraries/a/b/1', {}, 400],
    ['a library it doesn’t have', 'DELETE', '/api/libraries/a/b/1', undefined, 404],
  ] as const)('answers %s with an error', async (_name, method, url, payload, status) => {
    expect((await call(method, url, payload)).statusCode).toBe(status);
  });
});
