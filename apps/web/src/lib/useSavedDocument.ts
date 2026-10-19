import { useCallback, useEffect, useRef, useState } from 'react';

export interface DocumentApi<T> {
  load(signal?: AbortSignal): Promise<T>;
  save(value: T): Promise<T>;
}

/**
 * A document the gateway keeps (the watchlist, the flags): loaded once, retried every
 * `retryMs` until it loads, and saved back after every edit, one save at a time, the latest
 * winning. Nothing is saved before it has loaded, so a gateway that is briefly unreachable can
 * never overwrite what it holds with an empty or default one.
 */
export function useSavedDocument<T>(api: DocumentApi<T>, retryMs: number) {
  const [doc, setDoc] = useState<T | null>(null);
  const current = useRef<T | null>(null);
  const pending = useRef<T | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.load(abort.signal).then(
        (loaded) => {
          current.current = loaded;
          setDoc(loaded);
        },
        () => {
          if (!abort.signal.aborted) timer = setTimeout(load, retryMs);
        },
      );
    };
    load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, retryMs]);

  const flush = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        // On failure the document stays as edited here; the next edit saves it all again.
        await api.save(next).catch(() => {});
      }
    } finally {
      saving.current = false;
    }
  }, [api]);

  const edit = useCallback(
    (change: (doc: T) => T) => {
      const before = current.current;
      if (!before) return;
      const next = change(before);
      if (next === before) return;
      current.current = next;
      setDoc(next);
      pending.current = next;
      void flush();
    },
    [flush],
  );

  return { doc, edit };
}
