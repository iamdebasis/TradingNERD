import { join } from 'node:path';
import { type CoinGeckoPlan, isSipAccess, type SipAccess } from '@tradingnerd/core';
import { JsonFile } from './jsonFile.ts';

interface SecretsDoc {
  coingecko?: { key: string; plan: CoinGeckoPlan };
  alpaca?: { keyId: string; secret: string; sip: SipAccess };
}

const isPlan = (value: unknown): value is CoinGeckoPlan => value === 'demo' || value === 'pro';
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function parseSecrets(value: unknown): SecretsDoc | null {
  if (typeof value !== 'object' || value === null) return null;
  const { coingecko, alpaca } = value as Record<string, unknown>;
  const doc: SecretsDoc = {};
  if (coingecko !== undefined) {
    if (typeof coingecko !== 'object' || coingecko === null) return null;
    const { key, plan } = coingecko as Record<string, unknown>;
    if (!isText(key) || !isPlan(plan)) return null;
    doc.coingecko = { key, plan };
  }
  if (alpaca !== undefined) {
    if (typeof alpaca !== 'object' || alpaca === null) return null;
    const { keyId, secret, sip } = alpaca as Record<string, unknown>;
    if (!isText(keyId) || !isText(secret) || !isSipAccess(sip)) return null;
    doc.alpaca = { keyId, secret, sip };
  }
  return doc;
}

export interface StoredKey {
  key: string;
  /** Null for an environment key that hasn't been checked yet. */
  plan: CoinGeckoPlan | null;
  source: 'file' | 'env';
}

export interface StoredAlpacaKey {
  keyId: string;
  secret: string;
  /** Null for environment keys that haven't been checked yet. */
  sip: SipAccess | null;
  source: 'file' | 'env';
}

/**
 * Secrets the gateway keeps, in `data/secrets.json` readable by the owner only: the CoinGecko
 * key and the Alpaca key pair. Environment variables override the file (COINGECKO_API_KEY;
 * APCA_API_KEY_ID with APCA_API_SECRET_KEY, Alpaca's own names). Each is saved and removed on
 * its own, one change at a time, and the file goes once nothing is left in it. Nothing here
 * is ever logged or sent to the browser.
 */
export class SecretStore {
  private readonly file: JsonFile<SecretsDoc>;
  private readonly envKey: string | undefined;
  private envPlan: CoinGeckoPlan | null;
  private readonly envAlpaca: { keyId: string; secret: string } | undefined;
  private envSip: SipAccess | null = null;
  private changes: Promise<void> = Promise.resolve();

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = new JsonFile(join(dataDir, 'secrets.json'), parseSecrets, { mode: 0o600 });
    this.envKey = env.COINGECKO_API_KEY?.trim() || undefined;
    this.envPlan = isPlan(env.COINGECKO_PLAN) ? env.COINGECKO_PLAN : null;
    const keyId = env.APCA_API_KEY_ID?.trim();
    const secret = env.APCA_API_SECRET_KEY?.trim();
    this.envAlpaca = keyId && secret ? { keyId, secret } : undefined;
  }

  async coingecko(): Promise<StoredKey | null> {
    if (this.envKey) return { key: this.envKey, plan: this.envPlan, source: 'env' };
    const stored = (await this.read())?.coingecko;
    return stored ? { ...stored, source: 'file' } : null;
  }

  /** Remembers the plan an environment key turned out to have. */
  setEnvPlan(plan: CoinGeckoPlan): void {
    this.envPlan = plan;
  }

  saveCoingecko(key: string, plan: CoinGeckoPlan): Promise<void> {
    return this.change((doc) => ({ ...doc, coingecko: { key, plan } }));
  }

  removeCoingecko(): Promise<void> {
    return this.change(({ coingecko: _removed, ...rest }) => rest);
  }

  async alpaca(): Promise<StoredAlpacaKey | null> {
    if (this.envAlpaca) return { ...this.envAlpaca, sip: this.envSip, source: 'env' };
    const stored = (await this.read())?.alpaca;
    return stored ? { ...stored, source: 'file' } : null;
  }

  /** Remembers what the environment's Alpaca keys turned out to have. */
  setEnvSip(sip: SipAccess): void {
    this.envSip = sip;
  }

  saveAlpaca(keyId: string, secret: string, sip: SipAccess): Promise<void> {
    return this.change((doc) => ({ ...doc, alpaca: { keyId, secret, sip } }));
  }

  removeAlpaca(): Promise<void> {
    return this.change(({ alpaca: _removed, ...rest }) => rest);
  }

  /** The file's contents, once any change under way has been written. */
  private async read(): Promise<SecretsDoc | null> {
    await this.changes;
    return this.file.read();
  }

  /** One change at a time: read, change, then write (or remove the file once it's empty). */
  private change(apply: (doc: SecretsDoc) => SecretsDoc): Promise<void> {
    const run = this.changes.then(async () => {
      const next = apply((await this.file.read()) ?? {});
      if (next.coingecko || next.alpaca) await this.file.write(next);
      else await this.file.remove();
    });
    this.changes = run.catch(() => {});
    return run;
  }
}

/** "••••3f9a": just enough to recognise a key. */
export function maskKey(key: string): string {
  return key.length >= 8 ? `••••${key.slice(-4)}` : '••••';
}
