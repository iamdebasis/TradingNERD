import { libraryPath, parseLibraryPath, parseLibrarySource } from '@tradingnerd/core';
import { compileScript } from '@tradingnerd/pine';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import dialog from '../toolbar/AddIntervalDialog.module.css';
import { CloseIcon } from '../toolbar/icons';
import styles from './LibrariesDialog.module.css';
import { librariesStore, useLibraries } from './librariesStore';

/** "Oct 31, 2026", as the list shows when a library was added. */
const addedOn = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Why pasted code can't be added at a path, or null when it can: the path as an import writes
 * it, and code that compiles as a library (with the libraries it imports itself).
 */
export function libraryProblem(path: string, code: string): string | null {
  if (!parseLibraryPath(path)) {
    return 'Write the path as the import does: user/library/version, e.g. TradingView/ta/7';
  }
  if (parseLibrarySource(code) === null) return "Paste the library's code";
  const result = compileScript(code, librariesStore.compileOptions());
  if (!result.ok) {
    const error = result.errors[0];
    return error ? `Line ${error.line}: ${error.message}` : "The code doesn't compile";
  }
  if (!result.program.isLibrary) {
    return "This code isn't a library (it doesn't declare library()): paste the library's own code";
  }
  return null;
}

/**
 * The libraries the user's scripts import (docs/SPEC.md §5.17): each by its import path, with
 * its code pasted from its page on TradingView, since we never fetch from TradingView (§3). The
 * console's "Add library…" opens it with the path an import names. Provisional look, in the
 * app's dialog idiom: TradingView has no such dialog, as it fetches libraries itself (§11).
 */
export function LibrariesDialog({
  initialPath,
  onClose,
}: {
  initialPath: string | null;
  onClose(): void;
}) {
  const id = useId();
  const { libraries, error: loadError } = useLibraries();
  const [path, setPath] = useState(initialPath ?? '');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = libraryProblem(path, code);
    const ref = parseLibraryPath(path);
    if (found || !ref) {
      setProblem(found);
      return;
    }
    setBusy(true);
    const failed = await librariesStore.add(ref, code);
    setBusy(false);
    setProblem(failed);
    if (!failed) {
      setPath('');
      setCode('');
    }
  };

  return createPortal(
    <div className={dialog.backdrop}>
      <form
        className={`${dialog.dialog} ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={submit}
      >
        <div className={dialog.titleRow}>
          <h2 id={`${id}-title`} className={dialog.title}>
            Libraries
          </h2>
          <button type="button" className={dialog.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <ul className={styles.list} aria-label="My libraries">
          {libraries === null && <li className={styles.note}>Loading…</li>}
          {libraries?.length === 0 && (
            <li className={styles.note}>No libraries yet: scripts that import one need it here.</li>
          )}
          {libraries?.map((library) => {
            const name = libraryPath(library);
            return (
              <li key={name} className={styles.row}>
                <span className={styles.path}>{name}</span>
                <span className={styles.added}>{addedOn(library.addedAt)}</span>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    void librariesStore.remove(library).then(setProblem);
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        {loadError && <p className={dialog.hint}>{loadError}</p>}
        <h3 className={styles.heading}>Add library</h3>
        <label className={dialog.field}>
          <span className={dialog.label}>Import path</span>
          <input
            className={dialog.input}
            value={path}
            placeholder="user/library/version"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: opened from an import, the code is next to paste
            autoFocus={initialPath === null}
            onChange={(event) => {
              setPath(event.target.value);
              setProblem(null);
            }}
          />
        </label>
        <label className={`${dialog.field} ${styles.codeField}`}>
          <span className={dialog.label}>
            Code: copy it from the library's page on TradingView, then paste it here
          </span>
          <textarea
            className={styles.code}
            value={code}
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: the path is filled in, the code is what's left
            autoFocus={initialPath !== null}
            onChange={(event) => {
              setCode(event.target.value);
              setProblem(null);
            }}
          />
        </label>
        <p className={dialog.hint} role={problem ? 'alert' : undefined}>
          {problem ?? ' '}
        </p>
        <div className={dialog.actions}>
          <button type="button" className={dialog.cancel} onClick={onClose}>
            Close
          </button>
          <button type="submit" className={dialog.submit} disabled={busy}>
            Add library
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
