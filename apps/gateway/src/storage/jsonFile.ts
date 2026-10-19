import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface JsonFileOptions {
  /** File permissions: 0o600 for secrets. */
  mode?: number;
  /** Told when an unreadable file was moved aside. */
  onInvalid?: (movedTo: string) => void;
  /** Spaces per indent level; 0 writes one compact line, for large files. */
  indent?: number;
}

/**
 * One JSON document on disk. A write goes to a temporary file that then replaces the old one,
 * and writes run one at a time, so a crash never leaves half a file. A file that exists but
 * isn't valid is moved aside rather than silently overwritten later, so nothing is lost.
 */
export class JsonFile<T> {
  private readonly path: string;
  private readonly parse: (value: unknown) => T | null;
  private readonly mode: number;
  private readonly onInvalid: (movedTo: string) => void;
  private readonly indent: number;
  private queue: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(path: string, parse: (value: unknown) => T | null, options: JsonFileOptions = {}) {
    this.path = path;
    this.parse = parse;
    this.mode = options.mode ?? 0o644;
    this.onInvalid = options.onInvalid ?? (() => {});
    this.indent = options.indent ?? 2;
  }

  /** The stored value, or null when there is none (or it was unusable and moved aside). */
  async read(): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let value: T | null = null;
    try {
      value = this.parse(JSON.parse(text));
    } catch {
      value = null;
    }
    if (value === null) {
      const aside = `${this.path}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(this.path, aside);
      this.onInvalid(aside);
    }
    return value;
  }

  write(value: T): Promise<void> {
    const run = this.queue.then(() => this.writeNow(value));
    this.queue = run.catch(() => {});
    return run;
  }

  remove(): Promise<void> {
    const run = this.queue.then(() => rm(this.path, { force: true }));
    this.queue = run.catch(() => {});
    return run;
  }

  private async writeNow(value: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${this.counter++}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, this.indent)}\n`, { mode: this.mode });
    await chmod(temp, this.mode); // the mode given to writeFile is reduced by the umask
    await rename(temp, this.path);
  }
}
