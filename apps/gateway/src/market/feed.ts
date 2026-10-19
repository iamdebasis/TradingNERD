import type { StreamState } from '@tradingnerd/core';
import type { MarketError, Unsubscribe } from './types.ts';

export interface FeedListener {
  onState(state: StreamState): void;
  onError(error: MarketError): void;
}

/** Shared plumbing for one upstream feed fanned out to many listeners. */
export abstract class Feed<L extends FeedListener> {
  protected readonly listeners = new Set<L>();
  protected readonly unsubscribes: Unsubscribe[] = [];
  protected state: StreamState = 'reconnecting';
  protected disposed = false;
  private readonly onDispose: () => void;

  constructor(onDispose: () => void) {
    this.onDispose = onDispose;
  }

  add(listener: L): void {
    this.listeners.add(listener);
    // Catch the newcomer up asynchronously, never inside the subscribe call itself.
    queueMicrotask(() => {
      if (this.disposed || !this.listeners.has(listener) || this.state !== 'live') return;
      listener.onState('live');
      this.replay(listener);
    });
  }

  remove(listener: L): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.close();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.cleanup();
    this.onDispose();
  }

  protected setState(next: StreamState): void {
    if (next === this.state) return;
    this.state = next;
    this.broadcast((listener) => listener.onState(next));
  }

  protected broadcast(notify: (listener: L) => void): void {
    for (const listener of [...this.listeners]) notify(listener);
  }

  /** Ends the feed for everyone; later subscribers start a fresh feed and retry. */
  protected fail(error: MarketError): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    this.close();
    for (const listener of listeners) listener.onError(error);
  }

  /** Sends the current snapshot to a listener that joined while live. */
  protected abstract replay(listener: L): void;
  protected abstract cleanup(): void;
}
