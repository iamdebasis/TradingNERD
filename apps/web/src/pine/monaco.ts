import type * as Monaco from 'monaco-editor';
import { registerPine } from './language';

let loading: Promise<typeof Monaco> | null = null;

/**
 * Monaco, loaded the first time the Pine Editor opens: its API, its features, and its one worker
 * for the editor model, served from our own bundle (nothing comes from the internet).
 */
export function loadMonaco(): Promise<typeof Monaco> {
  loading ??= (async () => {
    const [monaco, worker] = await Promise.all([
      import('monaco-editor/editor/editor.api.js'),
      import('monaco-editor/editor/editor.worker.js?worker'),
      import('./features'),
    ]);
    self.MonacoEnvironment = { getWorker: () => new worker.default() };
    registerPine(monaco as unknown as typeof Monaco);
    return monaco as unknown as typeof Monaco;
  })();
  return loading;
}
