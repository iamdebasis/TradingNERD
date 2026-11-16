import type { ScriptRunner } from '@tradingnerd/chart';
import { type FromWorker, RemoteRun } from '@tradingnerd/pine';
import { librariesStore } from '../pine/librariesStore';

/**
 * Scripts in workers of their own (docs/SPEC.md §6.23): the page only draws what comes back, so a
 * heavy script never freezes the tab, and two run side by side on two cores. TradingView runs
 * Pine on its servers for the same reason (Pine docs, Welcome: "cloud-based"). A script let go
 * (removed, its inputs changed, another symbol) stops its worker at once.
 */

/** A runner whose workers `make` starts: each a script's own (scriptWorker.ts). */
function workers(make: () => Worker): ScriptRunner {
  return {
    run(options) {
      // Without workers (an old browser), scripts run in the page.
      if (typeof Worker === 'undefined') return null;
      const worker = make();
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
}

// Vite finds a worker by `new Worker(new URL(…), {…})` with options written out as they are
// (Vite's guide, Web Workers): each runner names its own, as the browser's task manager lists them.

/** The chart's scripts. */
export const workerScripts = workers(
  () =>
    new Worker(new URL('./scriptWorker.ts', import.meta.url), {
      type: 'module',
      name: 'Pine script',
    }),
);

/**
 * Alerts' copies of their scripts (alerts/AlertRunner.ts), each in a worker of its own too, as
 * TradingView runs alerts on its servers (Help Center, Will alerts work if TradingView is not
 * open on the computer?).
 */
export const alertScripts = workers(
  () =>
    new Worker(new URL('./scriptWorker.ts', import.meta.url), {
      type: 'module',
      name: 'Pine alert',
    }),
);
