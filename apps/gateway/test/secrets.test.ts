import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore } from '../src/storage/secrets.ts';

const KEY_ID = 'PKTESTKEYID123456789';
const SECRET = 'alpaca-secret-0000000000000000000000000';

function setup(env: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tn-secrets-'));
  return { store: new SecretStore(dataDir, env), file: join(dataDir, 'secrets.json'), dataDir };
}

describe('the secret store', () => {
  it('keeps the CoinGecko key and the Alpaca keys side by side, owner-readable only', async () => {
    const { store, file } = setup();
    await store.saveCoingecko('CG-key-1234', 'demo');
    await store.saveAlpaca(KEY_ID, SECRET, 'delayed');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      coingecko: { key: 'CG-key-1234', plan: 'demo' },
      alpaca: { keyId: KEY_ID, secret: SECRET, sip: 'delayed' },
    });
    expect(await store.alpaca()).toEqual({
      keyId: KEY_ID,
      secret: SECRET,
      sip: 'delayed',
      source: 'file',
    });
  });

  it('removes one without touching the other, and the file once both are gone', async () => {
    const { store, file } = setup();
    await store.saveCoingecko('CG-key-1234', 'demo');
    await store.saveAlpaca(KEY_ID, SECRET, 'realtime');
    await store.removeCoingecko();
    expect(await store.coingecko()).toBeNull();
    expect((await store.alpaca())?.sip).toBe('realtime');
    await store.removeAlpaca();
    expect(existsSync(file)).toBe(false);
  });

  it('never loses a change made at the same time as another', async () => {
    const { store } = setup();
    await Promise.all([
      store.saveCoingecko('CG-key-1234', 'pro'),
      store.saveAlpaca(KEY_ID, SECRET, 'delayed'),
    ]);
    expect((await store.coingecko())?.plan).toBe('pro');
    expect((await store.alpaca())?.keyId).toBe(KEY_ID);
  });

  it('reads the file the CoinGecko key was saved in before Alpaca existed', async () => {
    const { store, file } = setup();
    writeFileSync(file, JSON.stringify({ coingecko: { key: 'CG-old-5678', plan: 'demo' } }), {
      mode: 0o600,
    });
    expect((await store.coingecko())?.key).toBe('CG-old-5678');
    expect(await store.alpaca()).toBeNull();
  });

  it("lets Alpaca's own environment variables override the file", async () => {
    const { store } = setup({ APCA_API_KEY_ID: ` ${KEY_ID} `, APCA_API_SECRET_KEY: SECRET });
    expect(await store.alpaca()).toEqual({
      keyId: KEY_ID,
      secret: SECRET,
      sip: null,
      source: 'env',
    });
    store.setEnvSip('delayed');
    expect((await store.alpaca())?.sip).toBe('delayed');
    // Half a pair is no key at all.
    expect(await setup({ APCA_API_KEY_ID: KEY_ID }).store.alpaca()).toBeNull();
  });
});
