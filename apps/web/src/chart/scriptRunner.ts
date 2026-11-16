import type { ScriptRunner } from '@tradingnerd/chart';
import { type FromWorker, RemoteRun } from '@tradingnerd/pine';
import { librariesStore } from '../pine/librariesStore';

/**
 * The chart's scripts, each in a worker of its own (docs/SPEC.md §6.23): the page only draws what
 * comes back, so a heavy script never freezes the tab, and two run side by side on two cores.
 * TradingView runs Pine on its servers for the same reason (Pine docs, Welcome: "cloud-based").
 * A script let go (removed, its inputs changed, another symbol) stops its worker at once.
 */
export const workerScripts: ScriptRunner = {
  run(options) {
    // Without workers (an old browser or a test's page), scripts run in the page.
    if (typeof Worker === 'undefined') return null;
    const worker = new Worker(new URL('./scriptWorker.ts', import.meta.url), {
      type: 'module',
      name: 'Pine script',
    });
    const run = new RemoteRun(
      {
        post: (message, transfer) => worker.postMessage(message, transfer),
        close: () => worker.terminate(),
      },
      { ...options, libraries: librariesStore.codes() },
    );
    worker.onmessage = (event: MessageEvent<FromWorker>) => run.receive(event.data);
    worker.onerror = (event) => {
      // A worker that couldn't load or broke down: its script stops, saying so.
      event.preventDefault();
      run.crashed(event.message || 'The script’s worker stopped');
    };
    return run;
  },
};
