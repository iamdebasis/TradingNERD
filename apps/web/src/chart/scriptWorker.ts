import { ScriptHost, type ToWorker } from '@tradingnerd/pine';
import { currencyPath } from './currency';

/**
 * One Pine script's worker (docs/SPEC.md §6.23): it runs the script with the same engine the page
 * has, on its own copy of the chart's bars and its requests' contexts, so the page never waits on
 * it (scriptRunner.ts makes one per script on the chart).
 */

/** This worker's own scope: what it hears from the page, and how it answers. */
const scope = self as unknown as {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const host = new ScriptHost((message, transfer) => scope.postMessage(message, transfer), {
  rates: currencyPath,
});

scope.onmessage = (event) => host.receive(event.data);
