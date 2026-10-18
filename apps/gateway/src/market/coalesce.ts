export interface Coalescer<T> {
  /** Offers a value; it is emitted now or with the next window, whichever the rate allows. */
  push(value: T): void;
  /** Emits a held-back value immediately, if any. */
  flush(): void;
  /** Drops a held-back value without emitting it. */
  cancel(): void;
}

/**
 * Passes values through at most once per `intervalMs`: the first one immediately, then the
 * latest one at the end of each window, so a burst of updates costs one message per window
 * and the final state is never lost.
 */
export function createCoalescer<T>(intervalMs: number, emit: (value: T) => void): Coalescer<T> {
  let held: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastEmit = Number.NEGATIVE_INFINITY;

  const fire = () => {
    timer = undefined;
    if (!held) return;
    const { value } = held;
    held = null;
    lastEmit = Date.now();
    emit(value);
  };

  return {
    push(value) {
      held = { value };
      if (timer !== undefined) return;
      const wait = lastEmit + intervalMs - Date.now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      fire();
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      held = null;
    },
  };
}
