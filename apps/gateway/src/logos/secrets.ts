import { join } from 'node:path';
import type { CoinGeckoPlan } from '@tradingnerd/core';
import { JsonFile } from '../storage/jsonFile.ts';

interface SecretsDoc {
  coingecko?: { key: string; plan: CoinGeckoPlan };
}

const isPlan = (value: unknown): value is CoinGeckoPlan => value === 'demo' || value === 'pro';

function parseSecrets(value: unknown): SecretsDoc | null {
  if (typeof value !== 'object' || value === null) return null;
  const { coingecko } = value as Record<string, unknown>;
  if (coingecko === undefined) return {};
  if (typeof coingecko !== 'object' || coingecko === null) return null;
  const { key, plan } = coingecko as Record<string, unknown>;
  if (typeof key !== 'string' || key.length === 0 || !isPlan(plan)) return null;
  return { coingecko: { key, plan } };
}

export interface StoredKey {
  key: string;
  /** Null for an environment key that hasn't been checked yet. */
  plan: CoinGeckoPlan | null;
  source: 'file' | 'env';
}

/**
 * Secrets the gateway keeps: the CoinGecko key, in `data/secrets.json` readable by the owner
 * only. COINGECKO_API_KEY in the environment overrides the file. Nothing here is ever logged or
 * sent to the browser.
 */
export class SecretStore {
  private readonly file: JsonFile<SecretsDoc>;
  private readonly envKey: string | undefined;
  private envPlan: CoinGeckoPlan | null;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = new JsonFile(join(dataDir, 'secrets.json'), parseSecrets, { mode: 0o600 });
    this.envKey = env.COINGECKO_API_KEY?.trim() || undefined;
    this.envPlan = isPlan(env.COINGECKO_PLAN) ? env.COINGECKO_PLAN : null;
  }

  async coingecko(): Promise<StoredKey | null> {
    if (this.envKey) return { key: this.envKey, plan: this.envPlan, source: 'env' };
    const stored = (await this.file.read())?.coingecko;
    return stored ? { ...stored, source: 'file' } : null;
  }

  /** Remembers the plan an environment key turned out to have. */
  setEnvPlan(plan: CoinGeckoPlan): void {
    this.envPlan = plan;
  }

  async saveCoingecko(key: string, plan: CoinGeckoPlan): Promise<void> {
    await this.file.write({ coingecko: { key, plan } });
  }

  async removeCoingecko(): Promise<void> {
    await this.file.remove();
  }
}

/** "••••3f9a": just enough to recognise a key. */
export function maskKey(key: string): string {
  return key.length >= 8 ? `••••${key.slice(-4)}` : '••••';
}
