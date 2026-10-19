import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonFile } from '../src/storage/jsonFile.ts';

const parseNumbers = (value: unknown) =>
  Array.isArray(value) && value.every((n) => typeof n === 'number') ? (value as number[]) : null;

const fresh = () => join(mkdtempSync(join(tmpdir(), 'tradingnerd-json-')), 'nested', 'file.json');

describe('JsonFile', () => {
  it('reads nothing before the first write, then what was written', async () => {
    const file = new JsonFile(fresh(), parseNumbers);
    expect(await file.read()).toBeNull();
    await file.write([1, 2, 3]);
    expect(await file.read()).toEqual([1, 2, 3]);
  });

  it('writes secrets readable by the owner only, in an owner-only folder', async () => {
    const path = fresh();
    await new JsonFile(path, parseNumbers, { mode: 0o600 }).write([42]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  it('applies writes in order, the last one winning', async () => {
    const path = fresh();
    const file = new JsonFile(path, parseNumbers);
    await Promise.all(Array.from({ length: 20 }, (_, i) => file.write([i])));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([19]);
  });

  it('moves an unusable file aside and reports where', async () => {
    const path = fresh();
    const file = new JsonFile(path, parseNumbers);
    await file.write([1]);
    writeFileSync(path, '"not numbers"');
    const moved: string[] = [];
    const reader = new JsonFile(path, parseNumbers, { onInvalid: (to) => moved.push(to) });
    expect(await reader.read()).toBeNull();
    expect(moved).toHaveLength(1);
    expect(readFileSync(moved[0] as string, 'utf8')).toBe('"not numbers"');
    expect(await reader.read()).toBeNull(); // nothing left in the way
  });

  it('removes the file', async () => {
    const file = new JsonFile(fresh(), parseNumbers);
    await file.write([1]);
    await file.remove();
    expect(await file.read()).toBeNull();
    await file.remove(); // and again is fine
  });
});
