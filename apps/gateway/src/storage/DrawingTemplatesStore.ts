import { join } from 'node:path';
import {
  type DrawingTemplates,
  type DrawingTemplatesFile,
  parseDrawingTemplatesFile,
  parseToolTemplates,
  type ToolTemplates,
} from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from './jsonFile.ts';

/**
 * The user's drawing templates (docs/SPEC.md §5.27, D3b): a style saved under a name for one
 * tool, kept by the gateway in `data/drawing-templates.json` (gitignored), every tool's in one
 * file, as TradingView keeps them in the user's account. The file is read once; each save
 * changes one tool's templates and writes the whole file, whole or not at all (JsonFile).
 */
export class DrawingTemplatesStore {
  private readonly file: JsonFile<DrawingTemplatesFile>;
  private state: Promise<DrawingTemplatesFile> | null = null;
  private saves: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}) {
    this.file = new JsonFile(join(dataDir, 'drawing-templates.json'), parseDrawingTemplatesFile, {
      onInvalid: (movedTo) =>
        onWarning(
          `The drawing templates file was unreadable; kept it as ${movedTo} and started fresh`,
        ),
    });
  }

  /** Every tool's templates; none before any are saved. */
  async get(): Promise<DrawingTemplates> {
    const state = await this.load();
    return { tools: state.tools };
  }

  /**
   * Replaces a tool's templates; returns them as stored (normalized). Saves run one after
   * another, each building on the last, so two tools saved together both stay.
   */
  put(value: unknown): Promise<ToolTemplates> {
    const parsed = parseToolTemplates(value);
    if (!parsed) {
      return Promise.reject(
        new MarketError('bad_request', 'Those are not valid drawing templates'),
      );
    }
    const run = this.saves.then(() => this.save(parsed));
    this.saves = run.catch(() => {});
    return run;
  }

  private async save(parsed: ToolTemplates): Promise<ToolTemplates> {
    const state = await this.load();
    const tools = { ...state.tools };
    if (parsed.templates.length > 0) tools[parsed.tool] = parsed.templates;
    else delete tools[parsed.tool];
    const next: DrawingTemplatesFile = { version: 1, tools };
    await this.file.write(next);
    // Kept once written, as the drawings are: a save that couldn't be written leaves the
    // templates as stored. The next save waits for this one (`saves`), so it builds on it.
    this.state = Promise.resolve(next);
    return parsed;
  }

  private load(): Promise<DrawingTemplatesFile> {
    if (this.state) return this.state;
    const loading = this.file
      .read()
      .then((stored): DrawingTemplatesFile => stored ?? { version: 1, tools: {} })
      .catch((error: unknown) => {
        // Not kept: the next call reads the file again.
        this.state = null;
        throw error;
      });
    this.state = loading;
    return loading;
  }
}
