import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SCRIPTS,
  parseSavedScript,
  parseScriptsIndex,
  parseScriptVersionSource,
} from '@tradingnerd/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketError } from '../src/market/types.ts';
import { registerScriptRoutes } from '../src/routes/scripts.ts';
import { ScriptsStore } from '../src/storage/ScriptsStore.ts';

const RSI = '//@version=6\nindicator("RSI")\nplot(ta.rsi(close, 14))';
const EDITED = '//@version=6\nindicator("RSI")\nplot(ta.rsi(close, 21))';

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'tradingnerd-scripts-')), 'data');

/** A store whose clock moves on a second at each save. */
function store(dataDir = freshDir()): { scripts: ScriptsStore; dataDir: string } {
  let now = 1_700_000_000_000;
  return {
    scripts: new ScriptsStore(
      dataDir,
      () => {},
      () => (now += 1_000),
    ),
    dataDir,
  };
}

describe('My scripts, kept in data/scripts.json', () => {
  it('saves a new script as its version 1, with its name and the built-in it came from', async () => {
    const { scripts, dataDir } = store();
    const saved = await scripts.create({ name: 'My RSI', source: RSI, from: 'rsi' });
    expect(parseSavedScript(saved)).toEqual(saved);
    expect(saved).toMatchObject({ name: 'My RSI', from: 'rsi', version: 1, source: RSI });
    expect(saved.versions).toEqual([{ version: 1, savedAt: saved.savedAt }]);
    const file = JSON.parse(readFileSync(join(dataDir, 'scripts.json'), 'utf8'));
    expect(file).toMatchObject({
      version: 1,
      scripts: [{ id: saved.id, versions: [{ source: RSI }] }],
    });
  });

  it('makes each save that changes the code a new version, and one that doesn’t, none', async () => {
    const { scripts } = store();
    const { id } = await scripts.create({ name: 'My RSI', source: RSI });
    expect((await scripts.save(id, { source: RSI })).version).toBe(1);
    const saved = await scripts.save(id, { source: EDITED });
    expect(saved).toMatchObject({ version: 2, source: EDITED });
    expect(saved.versions.map((item) => item.version)).toEqual([1, 2]);
    expect((await scripts.version(id, 1)).source).toBe(RSI);
    expect((await scripts.get(id)).source).toBe(EDITED);
  });

  it('lists the latest saved first, without their code', async () => {
    const { scripts } = store();
    const a = await scripts.create({ name: 'A', source: RSI });
    const b = await scripts.create({ name: 'B', source: RSI });
    await scripts.save(a.id, { source: EDITED });
    const index = await scripts.index();
    expect(parseScriptsIndex(index)).toEqual(index);
    expect(index.scripts.map((item) => item.name)).toEqual(['A', 'B']);
    expect(index.scripts[1]).toEqual({
      id: b.id,
      name: 'B',
      from: null,
      version: 1,
      savedAt: b.savedAt,
    });
  });

  it('numbers a name already taken, on saving and on renaming', async () => {
    const { scripts } = store();
    await scripts.create({ name: 'My RSI', source: RSI });
    const second = await scripts.create({ name: 'my rsi', source: RSI });
    expect(second.name).toBe('my rsi 2');
    expect((await scripts.rename(second.id, { name: 'Faster RSI' })).name).toBe('Faster RSI');
    expect((await scripts.rename(second.id, { name: 'My RSI' })).name).toBe('My RSI 2');
  });

  it('deletes a script with all its versions', async () => {
    const { scripts } = store();
    const { id } = await scripts.create({ name: 'Gone', source: RSI });
    await scripts.save(id, { source: EDITED });
    expect((await scripts.remove(id)).scripts).toEqual([]);
    await expect(scripts.get(id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses what isn’t a script, an unknown id and a version it doesn’t have', async () => {
    const { scripts } = store();
    expect(() => scripts.create({ name: '', source: RSI })).toThrow(MarketError);
    expect(() => scripts.create({ name: 'A', source: 7 })).toThrow(MarketError);
    const { id } = await scripts.create({ name: 'A', source: RSI });
    expect(() => scripts.save(id, {})).toThrow(MarketError);
    await expect(scripts.get('s-nothere')).rejects.toMatchObject({ code: 'not_found' });
    await expect(scripts.get('../secrets')).rejects.toMatchObject({ code: 'not_found' });
    await expect(scripts.version(id, 9)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps up to its limit of scripts', async () => {
    const { scripts, dataDir } = store();
    await scripts.create({ name: 'First', source: '' });
    const file = JSON.parse(readFileSync(join(dataDir, 'scripts.json'), 'utf8'));
    const [first] = file.scripts;
    file.scripts = Array.from({ length: MAX_SCRIPTS }, (_, i) => ({
      ...first,
      id: `s-${i}`,
      name: `S ${i}`,
    }));
    writeFileSync(join(dataDir, 'scripts.json'), JSON.stringify(file));
    await expect(scripts.create({ name: 'One more', source: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('runs saves one at a time, so two at once keep both', async () => {
    const { scripts } = store();
    const { id } = await scripts.create({ name: 'A', source: RSI });
    await Promise.all([scripts.save(id, { source: 'one' }), scripts.save(id, { source: 'two' })]);
    expect((await scripts.get(id)).versions.map((item) => item.version)).toEqual([1, 2, 3]);
    expect((await scripts.version(id, 2)).source).toBe('one');
  });

  it('moves an unreadable file aside instead of losing it', async () => {
    const dataDir = freshDir();
    const { scripts } = store(dataDir);
    await scripts.create({ name: 'A', source: RSI });
    writeFileSync(join(dataDir, 'scripts.json'), '{ broken');
    const warnings: string[] = [];
    const reopened = new ScriptsStore(dataDir, (message) => warnings.push(message));
    expect((await reopened.index()).scripts).toEqual([]);
    expect(readdirSync(dataDir).some((name) => name.startsWith('scripts.json.invalid-'))).toBe(
      true,
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('The scripts routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const code = error instanceof MarketError ? error.code : 'internal_error';
      reply
        .code(code === 'not_found' ? 404 : code === 'bad_request' ? 400 : 500)
        .send({ error: code });
    });
    registerScriptRoutes(app, store().scripts);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('create, read, save, read a version, rename, list and delete', async () => {
    const created = (
      await call('POST', '/api/scripts', { name: 'My RSI', source: RSI, from: 'rsi' })
    ).json();
    expect(parseSavedScript(created)).toEqual(created);
    const { id } = created;
    expect((await call('GET', `/api/scripts/${id}`)).json()).toEqual(created);
    const saved = (await call('PUT', `/api/scripts/${id}`, { source: EDITED })).json();
    expect(saved.version).toBe(2);
    const first = (await call('GET', `/api/scripts/${id}/versions/1`)).json();
    expect(parseScriptVersionSource(first)).toMatchObject({ version: 1, source: RSI });
    expect((await call('PATCH', `/api/scripts/${id}`, { name: 'Faster RSI' })).json().name).toBe(
      'Faster RSI',
    );
    expect((await call('GET', '/api/scripts')).json().scripts).toHaveLength(1);
    expect((await call('DELETE', `/api/scripts/${id}`)).json()).toEqual({ scripts: [] });
  });

  it.each([
    [
      'a script without a name',
      'POST',
      '/api/scripts',
      { name: ' ', source: RSI },
      400,
      'bad_request',
    ],
    ['an unknown script', 'GET', '/api/scripts/s-nope', undefined, 404, 'not_found'],
    [
      'a version that isn’t a number',
      'GET',
      '/api/scripts/s-nope/versions/x',
      undefined,
      400,
      'bad_request',
    ],
  ] as const)('refuses %s', async (_name, method, url, payload, status, error) => {
    const res = await call(method, url, payload);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error });
  });
});
