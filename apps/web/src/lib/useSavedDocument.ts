import { useCallback, useEffect, useRef, useState } from 'react';

export interface DocumentApi<T> {
  load(signal?: AbortSignal): Promise<T>;
  save(value: T): Promise<T>;
}

/**
 * A document the gateway keeps (a watchlist, the flags): loaded once, retried every `retryMs`
 * until it loads, and saved back after every edit, one save at a time, the latest winning.
 * Nothing is saved before it has loaded, so a gateway that is briefly unreachable can never
 * overwrite what it holds with an empty or default one.
 *
 * `api` may change (another watchlist opened): the hook then starts over from nothing and
 * loads the new document once the edits still on their way to the gateway have been saved, so
 * a list opened again never shows less than was typed into it. Each document's edits are saved
 * to that document, whichever is shown by then. Null shows nothing.
 */
export function useSavedDocument<T>(api: DocumentApi<T> | null, retryMs: number) {
  const [doc, setDoc] = useState<T | null>(null);
  const current = useRef<T | null>(null);
  /** The latest edit not yet sent, for each document. */
  const pending = useRef(new Map<DocumentApi<T>, T>());
  const saving = useRef<Promise<void> | null>(null);

  useEffect(() => {
    current.current = null;
    setDoc(null);
    if (!api) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      // Edits still being saved go first, so the document comes back with them.
      await saving.current?.catch(() => {});
      if (abort.signal.aborted) return;
      api.load(abort.signal).then(
        (loaded) => {
          if (abort.signal.aborted) return;
          current.current = loaded;
          setDoc(loaded);
        },
        () => {
          if (!abort.signal.aborted) timer = setTimeout(load, retryMs);
        },
      );
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, retryMs]);

  const flush = useCallback(() => {
    if (saving.current) return;
    saving.current = (async () => {
      while (pending.current.size > 0) {
        const [target, value] = pending.current.entries().next().value as [DocumentApi<T>, T];
        pending.current.delete(target);
        // On failure the document stays as edited here; the next edit saves it all again.
        await target.save(value).catch(() => {});
      }
    })().finally(() => {
      saving.current = null;
    });
  }, []);

  const edit = useCallback(
    (change: (doc: T) => T) => {
      const before = current.current;
      if (!before || !api) return;
      const next = change(before);
      if (next === before) return;
      current.current = next;
      setDoc(next);
      pending.current.set(api, next);
      flush();
    },
    [api, flush],
  );

  return { doc, edit };
}
