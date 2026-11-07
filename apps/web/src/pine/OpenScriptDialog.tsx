import type { ScriptOrigin, ScriptSummary } from '@tradingnerd/core';
import { type IndicatorKind, indicatorDefinition } from '@tradingnerd/indicators';
import { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { scriptsApi } from '../data/api';
import { BUILTIN_CODE } from '../indicators/definitions';
import dialog from '../toolbar/AddIntervalDialog.module.css';
import { CloseIcon } from '../toolbar/icons';
import styles from './OpenScriptDialog.module.css';

/** "Oct 31, 10:20", as the list shows a script's last save. */
const savedOn = (ms: number) => {
  const date = new Date(ms);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${day}, ${time}`;
};

/**
 * Open script… (the script name's menu, Ctrl/Cmd + O): My scripts, the latest saved first, and
 * the built-ins whose code we have, found by name as you type (TradingView's Help Center, "How
 * to work with Pine Editor"). Provisional look, in the app's dialog idiom (docs/SPEC.md §11).
 */
export function OpenScriptDialog({
  onOpen,
  onBuiltin,
  onClose,
}: {
  onOpen(scriptId: string): void;
  onBuiltin(builtin: ScriptOrigin): void;
  onClose(): void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [scripts, setScripts] = useState<readonly ScriptSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    scriptsApi.index(abort.signal).then(
      (index) => setScripts(index.scripts),
      () => {
        if (!abort.signal.aborted) setFailed(true);
      },
    );
    return () => abort.abort();
  }, []);

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

  const needle = query.trim().toLowerCase();
  const mine = (scripts ?? []).filter((script) => script.name.toLowerCase().includes(needle));
  const builtins = useMemo(
    () =>
      (Object.keys(BUILTIN_CODE) as IndicatorKind[]).map((kind) => ({
        kind: kind as ScriptOrigin,
        name: indicatorDefinition(kind).name,
      })),
    [],
  );
  const shownBuiltins = builtins.filter((item) => item.name.toLowerCase().includes(needle));

  return createPortal(
    <div className={dialog.backdrop}>
      <div
        className={`${dialog.dialog} ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className={dialog.titleRow}>
          <h2 id={`${id}-title`} className={dialog.title}>
            Open script
          </h2>
          <button type="button" className={dialog.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <input
          className={dialog.input}
          aria-label="Search"
          placeholder="Search"
          value={query}
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to find a script
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className={styles.lists}>
          <h3 className={styles.heading}>My scripts</h3>
          <ul className={styles.list} aria-label="My scripts">
            {scripts === null && !failed && <li className={styles.note}>Loading…</li>}
            {failed && <li className={styles.note}>My scripts couldn't be loaded</li>}
            {scripts !== null && mine.length === 0 && (
              <li className={styles.note}>
                {scripts.length === 0 ? 'No saved scripts yet' : 'No script by that name'}
              </li>
            )}
            {mine.map((script) => (
              <li key={script.id}>
                <button type="button" className={styles.row} onClick={() => onOpen(script.id)}>
                  <span className={styles.name}>{script.name}</span>
                  <span className={styles.meta}>
                    {script.version} · {savedOn(script.savedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <h3 className={styles.heading}>Built-in</h3>
          <ul className={styles.list} aria-label="Built-in scripts">
            {shownBuiltins.length === 0 && (
              <li className={styles.note}>No built-in by that name</li>
            )}
            {shownBuiltins.map((item) => (
              <li key={item.kind}>
                <button type="button" className={styles.row} onClick={() => onBuiltin(item.kind)}>
                  <span className={styles.name}>{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>,
    document.body,
  );
}
